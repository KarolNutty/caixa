/**
 * Fila durável de cobranças.
 *
 * O problema: a pessoa conclui um pagamento e a rede cai no meio. Duas saídas
 * ruins e uma boa.
 *
 * Mostrar erro e pedir para tentar de novo joga fora o que ela já fez, e numa
 * conexão instável isso acontece repetidamente.
 *
 * Guardar em memória e reenviar depois funciona até a aba fechar, e aí o
 * pagamento some sem ninguém saber que existiu.
 *
 * O que este módulo faz: grava a intenção em IndexedDB **antes** de tentar a
 * rede, e só remove depois da confirmação do servidor. Se o processo morrer no
 * meio, a intenção continua lá na próxima abertura.
 *
 * O preço disso é a duplicata: um pedido pode ser enviado duas vezes se a
 * resposta se perder depois de o servidor processar. A chave de idempotência é
 * o que resolve, e ela é gerada **uma vez**, no momento da intenção, e reusada
 * em toda tentativa.
 */

const BANCO = 'caixa';
const VERSAO = 1;
const DEPOSITO = 'cobrancas';

/** Estados pelos quais uma cobrança passa. */
export const ESTADOS = {
  PENDENTE: 'pendente',
  ENVIANDO: 'enviando',
  CONFIRMADA: 'confirmada',
  RECUSADA: 'recusada',
};

/**
 * Erros que não adianta repetir.
 *
 * Cartão recusado e valor inválido não mudam por tentar de novo, e insistir
 * gasta bateria, incomoda o servidor e mantém na fila algo que nunca vai sair.
 * Falha de rede e erro de servidor, ao contrário, costumam passar sozinhos.
 */
const DEFINITIVOS = new Set([400, 401, 402, 403, 404, 409, 422]);

export function ehDefinitivo(status) {
  return DEFINITIVOS.has(status);
}

/**
 * Espera antes da próxima tentativa, em milissegundos.
 *
 * Cresce em dobro e para em cinco minutos. Sem o teto, a décima tentativa
 * aconteceria daqui a horas, e alguém que voltou a ter rede esperaria à toa.
 *
 * O ruído de até 30% existe para tentativas que falharam juntas não voltarem
 * juntas: sem ele, uma queda de rede que afeta mil pessoas produz mil pedidos
 * no mesmo instante quando a rede volta, e o servidor cai de novo.
 */
export function esperaAntesDe(tentativa, aleatorio = Math.random) {
  const base = Math.min(1000 * 2 ** tentativa, 5 * 60 * 1000);
  return Math.round(base * (0.7 + aleatorio() * 0.3));
}

/** Abre o banco, criando o depósito na primeira vez. */
export function abrirBanco(indexedDB = globalThis.indexedDB) {
  return new Promise((resolver, recusar) => {
    const pedido = indexedDB.open(BANCO, VERSAO);

    pedido.onupgradeneeded = () => {
      const bd = pedido.result;

      if (!bd.objectStoreNames.contains(DEPOSITO)) {
        // A chave é a de idempotência: ela identifica a cobrança para o
        // servidor e para o banco local ao mesmo tempo, e isso é o que impede
        // duas entradas para a mesma intenção.
        const deposito = bd.createObjectStore(DEPOSITO, { keyPath: 'chave' });
        deposito.createIndex('por_estado', 'estado');
        deposito.createIndex('por_criacao', 'criadaEm');
      }
    };

    pedido.onsuccess = () => resolver(pedido.result);
    pedido.onerror = () => recusar(pedido.error);
  });
}

function transacao(bd, modo) {
  return bd.transaction(DEPOSITO, modo).objectStore(DEPOSITO);
}

function comoPromessa(pedido) {
  return new Promise((resolver, recusar) => {
    pedido.onsuccess = () => resolver(pedido.result);
    pedido.onerror = () => recusar(pedido.error);
  });
}

/**
 * Guarda a intenção de cobrança.
 *
 * Acontece **antes** de qualquer tentativa de rede. É o que garante que uma
 * queda no meio do envio não apaga o que a pessoa fez.
 */
export async function enfileirar(bd, cobranca) {
  const registro = {
    ...cobranca,
    estado: ESTADOS.PENDENTE,
    tentativas: 0,
    criadaEm: Date.now(),
    proximaTentativaEm: 0,
    erro: null,
  };

  await comoPromessa(transacao(bd, 'readwrite').add(registro));
  return registro;
}

export async function listar(bd) {
  const todas = await comoPromessa(transacao(bd, 'readonly').getAll());
  return todas.sort((a, b) => a.criadaEm - b.criadaEm);
}

export async function buscar(bd, chave) {
  return comoPromessa(transacao(bd, 'readonly').get(chave));
}

export async function salvar(bd, registro) {
  await comoPromessa(transacao(bd, 'readwrite').put(registro));
  return registro;
}

export async function remover(bd, chave) {
  await comoPromessa(transacao(bd, 'readwrite').delete(chave));
}

/**
 * O que está pronto para ser enviado agora.
 *
 * Exclui o que está em espera por tentativa recente, e o que já terminou. A
 * ordem é de criação: quem tentou pagar primeiro é atendido primeiro, que é o
 * que a pessoa espera ao ver a fila.
 */
export function prontasParaEnvio(registros, agora = Date.now()) {
  return registros
    .filter(
      (registro) =>
        registro.estado === ESTADOS.PENDENTE && registro.proximaTentativaEm <= agora,
    )
    .sort((a, b) => a.criadaEm - b.criadaEm);
}

/**
 * Aplica o resultado de uma tentativa.
 *
 * Função pura de propósito: é a regra que decide se algo vira confirmado,
 * recusado ou volta para a fila, e ela precisa ser testável sem banco, sem
 * rede e sem esperar o tempo passar.
 */
export function aplicarResultado(registro, resultado, agora = Date.now(), aleatorio) {
  if (resultado.ok) {
    return {
      ...registro,
      estado: ESTADOS.CONFIRMADA,
      idNoServidor: resultado.id ?? null,
      confirmadaEm: agora,
      erro: null,
    };
  }

  const tentativas = registro.tentativas + 1;

  if (ehDefinitivo(resultado.status)) {
    return {
      ...registro,
      estado: ESTADOS.RECUSADA,
      tentativas,
      erro: resultado.mensagem ?? 'A cobrança foi recusada.',
    };
  }

  return {
    ...registro,
    estado: ESTADOS.PENDENTE,
    tentativas,
    proximaTentativaEm: agora + esperaAntesDe(tentativas, aleatorio),
    erro: resultado.mensagem ?? 'Sem conexão. Vamos tentar de novo.',
  };
}
