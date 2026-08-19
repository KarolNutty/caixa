import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { posix, join, normalize, sep } from 'node:path';

/**
 * Servidor de demonstração.
 *
 * Serve os arquivos e simula um meio de pagamento, com três coisas de
 * propósito: idempotência de verdade, falhas aleatórias e lentidão.
 *
 * As falhas existem porque um sistema de fila que só é testado com rede boa não
 * foi testado. Aqui elas acontecem sozinhas, e dá para ver a fila trabalhando.
 */

const PORTA = Number(process.env.PORTA ?? 4000);
const RAIZ = process.cwd();

/**
 * O que o servidor já processou, por chave de idempotência.
 *
 * Numa aplicação real isto é uma tabela com restrição de unicidade e um prazo
 * de validade. O comportamento observável é o mesmo: a segunda chamada com a
 * mesma chave devolve o resultado da primeira, sem cobrar de novo.
 */
const processadas = new Map();

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(resposta, status, corpo) {
  resposta.writeHead(status, { 'content-type': TIPOS['.json'] });
  resposta.end(JSON.stringify(corpo));
}

async function lerCorpo(requisicao) {
  const partes = [];
  for await (const parte of requisicao) partes.push(parte);

  try {
    return JSON.parse(Buffer.concat(partes).toString() || '{}');
  } catch {
    return null;
  }
}

async function criarCobranca(requisicao, resposta) {
  const chave = requisicao.headers['idempotency-key'];

  if (!chave) {
    return json(resposta, 400, { mensagem: 'Falta a chave de idempotência.' });
  }

  /*
   * A mesma chave devolve o mesmo resultado.
   *
   * É o que transforma uma retentativa em confirmação do mesmo pedido. Sem
   * isto, uma resposta perdida depois do processamento viraria cobrança dupla,
   * e o cliente pagaria duas vezes por um problema de rede.
   */
  if (processadas.has(chave)) {
    const anterior = processadas.get(chave);
    console.log(`  repetida  ${chave.slice(0, 8)} devolve ${anterior.id}`);
    return json(resposta, 200, { ...anterior, repetida: true });
  }

  const corpo = await lerCorpo(requisicao);

  if (!corpo || !Number.isInteger(corpo.valor) || corpo.valor < 100) {
    return json(resposta, 422, { mensagem: 'Valor inválido.' });
  }

  // Lentidão: sem ela, o estado "enviando" pisca rápido demais para ser visto,
  // e ninguém percebe que ele existe.
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 800));

  const sorte = Math.random();

  // 20% de falha temporária: é o que faz a fila mostrar para que serve.
  if (sorte < 0.2) {
    console.log(`  falhou    ${chave.slice(0, 8)} (temporária)`);
    return json(resposta, 503, { mensagem: 'Serviço indisponível.' });
  }

  // 10% de recusa definitiva, para o outro caminho também aparecer.
  if (sorte < 0.3) {
    console.log(`  recusada  ${chave.slice(0, 8)} (cartão)`);
    return json(resposta, 402, { mensagem: 'Cartão recusado pelo emissor.' });
  }

  const cobranca = {
    id: `pay_${Math.random().toString(36).slice(2, 10)}`,
    valor: corpo.valor,
    criadaEm: new Date().toISOString(),
  };

  processadas.set(chave, cobranca);
  console.log(`  criada    ${chave.slice(0, 8)} -> ${cobranca.id}`);

  return json(resposta, 201, cobranca);
}

/**
 * O que este servidor entrega.
 *
 * Só o que o navegador precisa para a aplicação funcionar. Sem a lista, ele
 * serve **qualquer arquivo da pasta**, incluindo o `.git` inteiro e um `.env`
 * se existisse. Num servidor de demonstração isso não derruba ninguém, e é o
 * mesmo descuido que em produção vira vazamento de credencial.
 *
 * A lista é de permissão, e não de bloqueio: bloquear o que se lembra deixa
 * passar o que se esquece, e o esquecido é sempre o que importa.
 */
const PASTAS_PUBLICAS = ['componentes', 'docs', 'estilos', 'nucleo'];
const ARQUIVOS_PUBLICOS = ['/index.html', '/app.js'];

/**
 * Resolve o caminho da URL para um caminho relativo, em formato de URL.
 *
 * Usa `posix` de propósito, e essa é a correção de um bug real: o `normalize`
 * comum converte as barras para o separador do sistema, e no Windows
 * `/index.html` vira `\index.html`. A checagem seguinte divide por barra
 * normal, não acha nada, e **tudo devolve 404 no Windows**.
 *
 * Caminho de URL e caminho de arquivo são coisas diferentes. URL sempre usa
 * barra normal, em qualquer sistema, e misturar os dois é o tipo de erro que
 * passa despercebido em quem desenvolve no mesmo sistema o tempo todo.
 */
function resolverCaminho(caminho) {
  const semBarraFinal = caminho.replace(/\/+$/, '');
  const ehArquivo = posix.extname(semBarraFinal) !== '';

  return posix.normalize(ehArquivo ? caminho : `${semBarraFinal}/index.html`);
}

/** Um caminho sem extensão e sem barra no fim é pasta. */
function ehPasta(caminho) {
  return caminho !== '/' && !caminho.endsWith('/') && posix.extname(caminho) === '';
}

function ehPublico(caminhoDeUrl) {
  if (ARQUIVOS_PUBLICOS.includes(caminhoDeUrl)) return true;

  const primeiraPasta = caminhoDeUrl.split('/')[1];
  return PASTAS_PUBLICAS.includes(primeiraPasta);
}

const TIPO_POR_EXTENSAO = TIPOS;

async function servirArquivo(caminho, resposta) {
  /*
   * Pasta sem barra no fim é redirecionada, e não servida direto.
   *
   * Servir `/docs` diretamente parece funcionar e quebra o CSS: o navegador
   * resolve `href="sistema.css"` relativo a `/docs`, tratando `docs` como
   * arquivo, e procura `/sistema.css`. Já `../estilos/caixa.css` resolve igual
   * nos dois casos, então metade do estilo carrega e o defeito parece outra
   * coisa.
   *
   * É por isso que todo servidor sério manda 301 para a barra: a URL define
   * como os caminhos relativos são resolvidos.
   */
  if (ehPasta(caminho)) {
    resposta.writeHead(301, { location: `${caminho}/` });
    return resposta.end();
  }

  const relativo = resolverCaminho(caminho);

  if (!ehPublico(relativo)) {
    resposta.writeHead(404);
    return resposta.end('não encontrado');
  }

  // A conversão para caminho do sistema acontece só aqui, no fim.
  const arquivo = join(RAIZ, normalize(relativo));

  /*
   * A conferência continua, mesmo com a lista de permissão.
   *
   * `normalize` de um caminho absoluto trava na raiz, então `../` já não sai da
   * pasta. Mas isso depende de detalhe da biblioteca padrão, e uma barreira que
   * custa uma linha não se remove por confiar na outra.
   */
  if (!arquivo.startsWith(RAIZ + sep) && arquivo !== RAIZ) {
    resposta.writeHead(403);
    return resposta.end();
  }

  try {
    const conteudo = await readFile(arquivo);

    resposta.writeHead(200, {
      'content-type':
        TIPO_POR_EXTENSAO[posix.extname(relativo)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });

    resposta.end(conteudo);
  } catch {
    resposta.writeHead(404);
    resposta.end('não encontrado');
  }
}

createServer(async (requisicao, resposta) => {
  const url = new URL(requisicao.url, `http://${requisicao.headers.host}`);

  if (url.pathname === '/api/cobrancas' && requisicao.method === 'POST') {
    return criarCobranca(requisicao, resposta);
  }

  return servirArquivo(url.pathname, resposta);
}).listen(PORTA, () => {
  console.log('');
  console.log(`  Caixa em http://localhost:${PORTA}`);
  console.log('');
  console.log('  O servidor recusa 20% das chamadas de propósito, e 10% em');
  console.log('  definitivo. É assim que dá para ver a fila trabalhando.');
  console.log('');
  console.log('  Para testar offline: abra as ferramentas do navegador,');
  console.log('  aba Rede, e marque "Offline". Crie cobranças, volte a ficar');
  console.log('  online, e veja elas subirem sozinhas.');
  console.log('');
});
