const BUSCA_ALERTAS = 'label:vagas is:unread';
const MODELO = 'gemini-3.5-flash-lite';
const ESPERA_ENTRE_CHAMADAS_MS = 4000;
const LIMITE_TEXTO = 12000;
const TEMPO_MAXIMO_MS = 3.5 * 60 * 1000;
const COLUNAS = ['data', 'fonte', 'empresa', 'titulo', 'nivel', 'local', 'modelo', 'link', 'nota', 'motivos', 'atencao', 'decisao', 'resumido'];
const PARAMETROS_RASTREAMENTO = /^(utm_|gh_src$|trk|tracking|ref|lipi$|mid|otp|eid$)/i;

const NOTA_MINIMA = 7;
const NIVEIS_ACEITOS = ['estagio', 'trainee', 'junior', 'nao_informado'];
const INTERVALO_NOVA_TENTATIVA_MIN = 15;
const HORARIO_LIMITE = '22:45';

// Perfil de exemplo: substitua pelos seus dados
const PERFIL = `Estudante de [CURSO] em [CIDADE], conclusão prevista em [ANO].
Busca estágio em [ÁREA], com [CARGA HORÁRIA] por dia.
Experiência: [PROJETOS E FERRAMENTAS PRINCIPAIS].
Sem experiência profissional formal.
Modelos de trabalho aceitos: presencial somente em [CIDADE A]; híbrido em [CIDADE A], [CIDADE B] ou [CIDADE C]; remoto em qualquer lugar.
Vagas presenciais fora de [CIDADE A] e vagas híbridas fora dessas três cidades não servem para o candidato. Cidades da região metropolitana não contam como a cidade principal.`;

const INSTRUCAO = `Você recebe o texto de um e-mail de alerta de vagas e devolve as vagas encontradas, avaliadas para o candidato abaixo.

CANDIDATO
${PERFIL}

COMO EXTRAIR
1. Extraia cada vaga específica do e-mail, com empresa, título, nível, local e link.
2. Ignore links que não sejam de uma vaga específica, como páginas de pesquisa, preferências de e-mail e propagandas.
3. Não invente informação. Se o e-mail não informar o local ou o modelo de trabalho, use "nao_informado".
4. Se o e-mail não tiver nenhuma vaga, devolva a lista vazia.

COMO CLASSIFICAR O NÍVEL
estagio: estágio, internship, summer internship, winter internship.
trainee: trainee, programas de formação e de jovens talentos.
junior: júnior, junior, entry level, assistente, nível I.
pleno: pleno, mid-level, nível II.
senior: sênior, senior, especialista, staff, principal, lead.
outro: gerência, coordenação, consultoria ou cargos de liderança.
nao_informado: quando o título e o texto não indicam o nível.

COMO DAR A NOTA (0 a 10)
0 a 2: nível pleno, senior ou outro, independentemente da área.
3 a 4: nível aceito, mas em área sem relação com dados ou IA.
5 a 6: nível aceito em dados ou IA, mas com local ou modelo de trabalho incompatível.
7 a 8: estágio, trainee ou júnior em dados ou IA, com local compatível.
9 a 10: estágio ou trainee em dados ou IA, com encaixe claro no perfil e no modelo de trabalho.
Se o nível for nao_informado, avalie pela área e pelo local, e explique a dúvida em "atencao".

Antes de escrever "atencao", confira o local e o modelo da vaga contra as regras do candidato. Só aponte incompatibilidade de local se a vaga realmente violar essas regras. Híbrido nas cidades aceitas no perfil é aceito.
Se o modelo de trabalho for nao_informado e a vaga não for na cidade aceita para trabalho presencial, não presuma que é presencial nem remoto. Escreva em "atencao" que é preciso confirmar se a vaga é híbrida ou remota.

Em "motivos", escreva até duas frases curtas sobre o que favorece o encaixe.
Em "atencao", escreva uma frase sobre o principal risco, como um requisito que o candidato não tem ou uma data de formatura incompatível. Se não houver, deixe vazio.`;

const ESQUEMA = {
  type: 'OBJECT',
  properties: {
    vagas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          empresa: { type: 'STRING' },
          titulo: { type: 'STRING' },
          nivel: { type: 'STRING', enum: ['estagio', 'trainee', 'junior', 'pleno', 'senior', 'outro', 'nao_informado'] },
          local: { type: 'STRING' },
          modelo: { type: 'STRING', enum: ['presencial', 'hibrido', 'remoto', 'nao_informado'] },
          link: { type: 'STRING' },
          nota: { type: 'INTEGER' },
          motivos: { type: 'STRING' },
          atencao: { type: 'STRING' },
        },
        required: ['empresa', 'titulo', 'nivel', 'local', 'modelo', 'link', 'nota', 'motivos', 'atencao'],
      },
    },
  },
  required: ['vagas'],
};

// Disparada todo dia entre 18h e 19h e a cada nova tentativa
function rotinaDiaria() {
  const propriedades = PropertiesService.getScriptProperties();
  const hoje = formatarAgora('yyyy-MM-dd');
  if (propriedades.getProperty('ULTIMO_RESUMO') === hoje) return;

  triagem();
  const pendentes = GmailApp.search(BUSCA_ALERTAS).length;

  if (pendentes > 0 && formatarAgora('HH:mm') < HORARIO_LIMITE) {
    ScriptApp.newTrigger('novaTentativa').timeBased().after(INTERVALO_NOVA_TENTATIVA_MIN * 60 * 1000).create();
    Logger.log(`${pendentes} alerta(s) pendente(s). Nova tentativa em ${INTERVALO_NOVA_TENTATIVA_MIN} minutos.`);
    return;
  }

  enviarResumo(pendentes);
  propriedades.setProperty('ULTIMO_RESUMO', hoje);
}

// Remove o gatilho de uso único que a disparou e roda a rotina de novo
function novaTentativa() {
  ScriptApp.getProjectTriggers()
    .filter((gatilho) => gatilho.getHandlerFunction() === 'novaTentativa')
    .forEach((gatilho) => ScriptApp.deleteTrigger(gatilho));
  rotinaDiaria();
}

function triagem() {
  const inicio = Date.now();
  const propriedades = PropertiesService.getScriptProperties();
  const chave = propriedades.getProperty('GEMINI_API_KEY');
  const aba = SpreadsheetApp.openById(propriedades.getProperty('PLANILHA_ID')).getSheetByName('vagas');

  let processados = 0;
  let falhas = 0;
  let vagasNovas = 0;

  for (const conversa of GmailApp.search(BUSCA_ALERTAS)) {
    for (const mensagem of conversa.getMessages().filter((m) => m.isUnread())) {
      // Para antes do limite de 6 minutos; o restante fica para a próxima execução
      if (Date.now() - inicio > TEMPO_MAXIMO_MS) {
        Logger.log('Tempo limite atingido, o restante fica para a próxima execução.');
        return registrarResultado(processados, falhas, vagasNovas);
      }

      try {
        const vagas = avaliarComGemini(chave, mensagem.getSubject(), limparTexto(mensagem.getPlainBody()));
        const fonte = identificarFonte(mensagem.getFrom());
        vagasNovas += gravarVagas(aba, vagas.map((vaga) => ({ ...vaga, fonte })));
        mensagem.markRead();
        processados++;
      } catch (erro) {
        falhas++;
        Logger.log(`Falha no alerta "${mensagem.getSubject()}": ${erro.message}`);
      }

      Utilities.sleep(ESPERA_ENTRE_CHAMADAS_MS);
    }
  }

  return registrarResultado(processados, falhas, vagasNovas);
}

function registrarResultado(processados, falhas, vagasNovas) {
  Logger.log(`Alertas processados: ${processados}. Falhas: ${falhas}. Vagas novas na planilha: ${vagasNovas}.`);
  return { processados, falhas, vagasNovas };
}

// Encurta os links do LinkedIn e remove parâmetros de rastreamento antes de enviar ao Gemini
function limparTexto(corpo) {
  return corpo
    .replace(/https:\/\/www\.linkedin\.com\/comm\/jobs\/view\/(\d+)\S*/g, 'https://www.linkedin.com/jobs/view/$1')
    .replace(/https?:\/\/\S+/g, removerRastreamento)
    .replace(/-{5,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITE_TEXTO);
}

// Mantém parâmetros que podem identificar a vaga, como ?jobId=123
function removerRastreamento(link) {
  const [base, consulta] = link.split('?');
  if (!consulta) return link;
  const mantidos = consulta
    .split('&')
    .filter((parametro) => !PARAMETROS_RASTREAMENTO.test(parametro.split('=')[0]));
  return mantidos.length ? `${base}?${mantidos.join('&')}` : base;
}

function avaliarComGemini(chave, assunto, texto) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;
  const corpo = {
    systemInstruction: { parts: [{ text: INSTRUCAO }] },
    contents: [{ role: 'user', parts: [{ text: `Assunto: ${assunto}\n\n${texto}` }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: ESQUEMA },
  };

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const resposta = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': chave },
      payload: JSON.stringify(corpo),
      muteHttpExceptions: true,
    });

    const status = resposta.getResponseCode();
    if (status === 200) {
      const textoResposta = JSON.parse(resposta.getContentText()).candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textoResposta) throw new Error('Resposta do Gemini sem conteúdo');
      return JSON.parse(textoResposta).vagas || [];
    }

    // Só vale tentar de novo em sobrecarga ou erro temporário do servidor
    if (tentativa === 2 || (status !== 429 && status < 500)) {
      throw new Error(`Gemini respondeu com status ${status}`);
    }
    Utilities.sleep(5000);
  }
}

function identificarFonte(remetente) {
  if (remetente.includes('jobalerts-noreply@linkedin.com')) return 'LinkedIn (alerta)';
  if (remetente.includes('jobs-noreply@linkedin.com')) return 'LinkedIn (recomendação)';
  if (remetente.includes('greenhouse')) return 'Greenhouse';
  return 'Outra';
}

// Grava só as vagas cujo link ainda não está na planilha e devolve quantas entraram
function gravarVagas(aba, vagas) {
  const colunaLink = COLUNAS.indexOf('link') + 1;
  const ultimaLinha = aba.getLastRow();
  const linksExistentes = new Set(
    ultimaLinha > 1 ? aba.getRange(2, colunaLink, ultimaLinha - 1, 1).getValues().flat() : []
  );
  const hoje = formatarAgora('yyyy-MM-dd');

  const novasLinhas = [];
  for (const vaga of vagas) {
    const link = String(vaga.link || '').trim();
    if (!link || linksExistentes.has(link)) continue;
    linksExistentes.add(link);
    novasLinhas.push(COLUNAS.map((coluna) => {
      if (coluna === 'data') return hoje;
      if (coluna === 'link') return link;
      return vaga[coluna] ?? '';
    }));
  }

  if (novasLinhas.length) {
    aba.getRange(ultimaLinha + 1, 1, novasLinhas.length, COLUNAS.length).setValues(novasLinhas);
  }
  return novasLinhas.length;
}

function enviarResumo(pendentes) {
  const aba = SpreadsheetApp
    .openById(PropertiesService.getScriptProperties().getProperty('PLANILHA_ID'))
    .getSheetByName('vagas');
  const [cabecalho, ...linhas] = aba.getDataRange().getValues();
  const coluna = Object.fromEntries(cabecalho.map((nome, i) => [nome, i]));

  const ehNova = (linha) => linha[coluna.link] && !linha[coluna.resumido];
  const novas = linhas.filter(ehNova);
  const nivelAceito = novas.filter((linha) => NIVEIS_ACEITOS.includes(linha[coluna.nivel]));
  const destaques = nivelAceito
    .filter((linha) => Number(linha[coluna.nota]) >= NOTA_MINIMA)
    .sort((a, b) => Number(b[coluna.nota]) - Number(a[coluna.nota]));

  const itens = destaques.map((linha) => `
    <li>
      <strong>${linha[coluna.nota]}/10</strong>:
      <a href="${escaparHtml(linha[coluna.link])}">${escaparHtml(linha[coluna.titulo])}</a>,
      ${escaparHtml(linha[coluna.empresa])} (${linha[coluna.nivel]}, ${escaparHtml(linha[coluna.local])}, ${linha[coluna.modelo]})<br>
      ${escaparHtml(linha[coluna.motivos])}
      ${linha[coluna.atencao] ? `<br><em>Atenção: ${escaparHtml(linha[coluna.atencao])}</em>` : ''}
    </li>`).join('');

  const aviso = pendentes > 0
    ? `<p><strong>${pendentes} alerta(s) não foram processados hoje e serão tentados amanhã.</strong></p>`
    : '';
  const contagem = `<p>${novas.length} vagas analisadas: ${novas.length - nivelAceito.length} de nível incompatível, ${destaques.length} em destaque.</p>`;
  const lista = destaques.length ? `<ol>${itens}</ol>` : '<p>Nenhuma vaga em destaque hoje.</p>';

  GmailApp.sendEmail(
    Session.getEffectiveUser().getEmail(),
    `Vagas do dia: ${destaques.length} em destaque`,
    `${novas.length} vagas analisadas, ${destaques.length} em destaque.`,
    { htmlBody: aviso + contagem + lista }
  );

  // Marca como resumidas as vagas incluídas neste e-mail
  if (linhas.length) {
    const resumido = linhas.map((linha) => [ehNova(linha) ? 'sim' : linha[coluna.resumido]]);
    aba.getRange(2, coluna.resumido + 1, linhas.length, 1).setValues(resumido);
  }
}

function formatarAgora(formato) {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), formato);
}

function escaparHtml(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Rode para testar o e-mail de resumo sem esperar o gatilho
function testarResumo() {
  enviarResumo(0);
}

// Rode uma vez para agendar a rotina diária
function instalarGatilhos() {
  ScriptApp.getProjectTriggers().forEach((gatilho) => ScriptApp.deleteTrigger(gatilho));
  ScriptApp.newTrigger('rotinaDiaria').timeBased().everyDays(1).atHour(18).create();
  Logger.log('Rotina agendada para todo dia entre 18h e 19h.');
}
