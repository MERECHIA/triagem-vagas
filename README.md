# Triagem de vagas

Automação em Google Apps Script que lê alertas de vaga recebidos no Gmail, avalia cada vaga com o Gemini, grava o resultado no Google Sheets e envia um e-mail diário de resumo com as vagas em destaque.

## O problema

Alertas de vaga chegam por e-mail de várias plataformas, como LinkedIn e Greenhouse. A maioria não serve para o meu perfil, que é estágio, trainee ou júnior em dados e IA, e triar cada e-mail à mão leva tempo.

## Como funciona

1. Um gatilho diário dispara a função `rotinaDiaria` em algum momento entre 18h e 19h.
2. O script busca no Gmail os alertas não lidos com o marcador Vagas (`label:vagas is:unread`).
3. O texto de cada e-mail é limpo: os links de vaga do LinkedIn são encurtados para `https://www.linkedin.com/jobs/view/<id>`; nos demais links, são removidos só os parâmetros de rastreamento conhecidos (como `utm_*`, `gh_src`, `trk*` e `ref*`), e os parâmetros que podem identificar a vaga, como `?jobId=123`, são mantidos. Linhas de traços e espaços repetidos são compactados, e o texto é cortado em 12.000 caracteres.
4. O texto limpo vai ao Gemini em uma chamada por e-mail, com uma instrução de sistema e um esquema JSON de saída estruturada. O Gemini devolve a lista de vagas do e-mail, cada uma com empresa, título, nível, local, modelo de trabalho, link, nota, motivos e pontos de atenção.
5. As vagas são gravadas na aba `vagas` da planilha. Uma vaga cujo link já está na planilha é ignorada, para não duplicar.
6. O e-mail é marcado como lido. Se a chamada ao Gemini ou a gravação falhar, o e-mail continua não lido e entra na próxima tentativa.
7. Se ainda sobrar algum alerta não lido, o script cria um gatilho de uso único para tentar de novo em 15 minutos. Isso se repete até 22h45.
8. Quando não há mais alertas pendentes, ou quando o horário limite passa, o script envia um único e-mail de resumo para a própria conta, com as vagas em destaque (nível aceito e nota 7 ou mais) ordenadas pela nota, e marca essas vagas como resumidas na planilha. O resumo é enviado no máximo uma vez por dia.

## Decisões de projeto

| Decisão | Motivo |
| --- | --- |
| Apps Script em vez de n8n | É gratuito e não precisa de servidor: roda na conta Google, com acesso direto ao Gmail e ao Sheets. O n8n Cloud é pago depois do período de teste. |
| Limpeza dos links antes do Gemini | Reduz o texto enviado, remove tokens de rastreamento e deixa cada vaga com um link estável, o que permite detectar vagas repetidas. |
| Remover só parâmetros de rastreamento conhecidos, em vez de todos | Algumas plataformas usam um parâmetro para identificar a vaga, como `?jobId=123`. Remover todos os parâmetros deixaria vagas diferentes com o mesmo link, e a checagem de repetidas juntaria essas vagas. |
| Uma chamada ao Gemini por e-mail | Cada alerta traz várias vagas, e o Gemini extrai e avalia todas de uma vez, com menos chamadas à API. |
| Temperatura 0,2 | Uma temperatura baixa deixa a extração e a nota mais estáveis entre execuções, o que importa numa tarefa de classificação. |
| Nível classificado e filtrado no resumo, em vez de descartado | Todas as vagas vão para a planilha com o nível. O filtro só acontece no resumo, o que preserva o dado de quantas vagas eram incompatíveis. |
| Vaga repetida ignorada | Se o link já existe, a linha antiga não é reescrita, o que preserva a coluna `decisao` preenchida à mão. |
| Novas tentativas com horário limite | Um alerta que falha não prende o script num loop infinito: as tentativas param às 22h45 e o resumo sai mesmo assim. |
| "Nenhum alerta não lido" como sinal de fim | O estado de lido do próprio Gmail mostra o que falta processar, sem precisar guardar uma fila separada. |

## A instrução e o esquema do Gemini

A instrução de sistema (`INSTRUCAO`) inclui o perfil do candidato (`PERFIL`) e regras para extrair, classificar e dar nota. O esquema (`ESQUEMA`) é enviado como `responseSchema`, com `responseMimeType: 'application/json'`, e força a resposta a ser um objeto com uma lista `vagas`.

### Níveis

O nível é um campo fechado no esquema:

```js
nivel: { type: 'STRING', enum: ['estagio', 'trainee', 'junior', 'pleno', 'senior', 'outro', 'nao_informado'] },
```

A instrução diz como mapear os termos dos alertas para cada valor:

```
COMO CLASSIFICAR O NÍVEL
estagio: estágio, internship, summer internship, winter internship.
trainee: trainee, programas de formação e de jovens talentos.
junior: júnior, junior, entry level, assistente, nível I.
pleno: pleno, mid-level, nível II.
senior: sênior, senior, especialista, staff, principal, lead.
outro: gerência, coordenação, consultoria ou cargos de liderança.
nao_informado: quando o título e o texto não indicam o nível.
```

O modelo de trabalho também é fechado, com `presencial`, `hibrido`, `remoto` e `nao_informado`. A instrução proíbe inventar: "Se o e-mail não informar o local ou o modelo de trabalho, use "nao_informado"."

### Escala de notas

A nota é um inteiro de 0 a 10, definido por faixas que combinam nível, área e local:

```
COMO DAR A NOTA (0 a 10)
0 a 2: nível pleno, senior ou outro, independentemente da área.
3 a 4: nível aceito, mas em área sem relação com dados ou IA.
5 a 6: nível aceito em dados ou IA, mas com local ou modelo de trabalho incompatível.
7 a 8: estágio, trainee ou júnior em dados ou IA, com local compatível.
9 a 10: estágio ou trainee em dados ou IA, com encaixe claro no perfil e no modelo de trabalho.
Se o nível for nao_informado, avalie pela área e pelo local, e explique a dúvida em "atencao".
```

No resumo, entram as vagas com nível em `NIVEIS_ACEITOS` e nota a partir de `NOTA_MINIMA`:

```js
const NOTA_MINIMA = 7;
const NIVEIS_ACEITOS = ['estagio', 'trainee', 'junior', 'nao_informado'];
```

### Motivos e atenção

Cada vaga traz dois textos curtos. Em `motivos`, "até duas frases curtas sobre o que favorece o encaixe". Em `atencao`, "uma frase sobre o principal risco, como um requisito que o candidato não tem ou uma data de formatura incompatível". Antes de escrever `atencao`, o Gemini deve conferir o local e o modelo contra as regras do candidato e só apontar incompatibilidade se a vaga realmente violar essas regras. Quando o modelo de trabalho não é informado, a instrução manda não presumir e pedir confirmação.

## Como configurar

1. **Perfil.** Crie um projeto no [Apps Script](https://script.google.com), cole o conteúdo de `src/Codigo.gs` e substitua o `PERFIL` de exemplo pelos seus dados.
2. **Planilha.** Crie uma planilha no Google Sheets com uma aba chamada `vagas`. Na linha 1, escreva o cabeçalho nesta ordem:

   `data`, `fonte`, `empresa`, `titulo`, `nivel`, `local`, `modelo`, `link`, `nota`, `motivos`, `atencao`, `decisao`, `resumido`

   O script grava as colunas nessa ordem e lê o resumo pelos nomes do cabeçalho. A coluna `decisao` é para você preencher à mão; `resumido` é preenchida pelo script.
3. **Gmail.** Crie o marcador `Vagas` e um filtro que aplique esse marcador aos alertas de vaga (por exemplo, os remetentes `jobalerts-noreply@linkedin.com`, `jobs-noreply@linkedin.com` e os alertas do Greenhouse). O filtro não deve marcar os e-mails como lidos, porque o script só processa os não lidos.
4. **Propriedades do script.** Em Configurações do projeto > Propriedades do script, crie:
   - `GEMINI_API_KEY`: sua chave da API do Gemini.
   - `PLANILHA_ID`: o ID da planilha, o trecho da URL entre `/d/` e `/edit`.

   O script também cria sozinho a propriedade `ULTIMO_RESUMO`, para não enviar dois resumos no mesmo dia.
5. **Gatilho.** Rode uma vez a função `instalarGatilhos` e autorize os acessos pedidos. Ela apaga todos os gatilhos do projeto e cria o gatilho diário de `rotinaDiaria` entre 18h e 19h. Para testar o e-mail de resumo sem esperar o gatilho, rode `testarResumo`.

## Segurança e privacidade

- A chave do Gemini e o ID da planilha ficam nas propriedades do script, não no código.
- Os links são limpos antes de sair do Gmail. Os do LinkedIn são encurtados até o ID da vaga, o que remove parâmetros de acesso, como `otpToken`, e os de rastreamento. Nos demais links, os parâmetros de rastreamento conhecidos são removidos, e os que podem identificar a vaga são mantidos. Os parâmetros removidos não chegam ao Gemini nem à planilha.
- O texto dos alertas, já limpo, é enviado à API do Gemini, do Google.
- O perfil publicado neste repositório é um exemplo. O perfil real fica só no projeto do Apps Script.

## Resultados

Em medição, atualizado em 12/11/2026

## Painel

Link e capturas em breve

## Limitações conhecidas

- O Gemini às vezes erra regras de local e já presumiu um modelo de trabalho que o alerta não informava. Isso foi corrigido na instrução, que agora manda conferir o local contra as regras e não presumir o modelo.
- A maioria dos alertas do LinkedIn não informa o modelo de trabalho, então muitas vagas chegam como `nao_informado` e pedem confirmação.
- A qualidade do resultado depende dos alertas configurados nas plataformas: o script só avalia o que chega ao Gmail.
- O gatilho diário roda em algum momento entre 18h e 19h, não num horário exato.
- Um alerta que falhe sempre segura o resumo até 22h45, porque o script continua tentando enquanto houver alerta não lido.
- Contas gratuitas do Google têm cotas diárias no Apps Script, como as de chamadas externas, e-mails enviados e tempo de execução de gatilhos.

## Uso de IA

O código foi escrito com a ajuda do Claude, a partir das decisões que tomei e dos testes que fiz com alertas reais. As respostas da automação são geradas pelo Gemini.
