/**
 * Regras de cobrança.
 *
 * Puras de propósito: nenhuma toca rede, DOM ou banco. É o que permite testá-las
 * sem montar nada, e o que garante que a mesma regra vale na tela e antes do
 * envio.
 */

/**
 * A chave de idempotência.
 *
 * Gerada **uma vez**, quando a pessoa confirma, e reusada em toda tentativa. É
 * o que transforma "tentar de novo" em "confirmar o mesmo pedido" para o
 * servidor, em vez de "cobrar outra vez".
 *
 * `randomUUID` quando existe, e uma composição de tempo e acaso quando não:
 * navegador antigo ou contexto sem HTTPS não expõem a API, e falhar ali
 * impediria a cobrança inteira por causa de um detalhe.
 */
export function novaChave(cripto = globalThis.crypto) {
  if (cripto?.randomUUID) return cripto.randomUUID();

  const acaso = Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${acaso}`;
}

export const VALOR_MINIMO = 100;
export const VALOR_MAXIMO = 5_000_000;

/**
 * O que impede uma cobrança de ser enviada.
 *
 * Devolve a lista de problemas, e não o primeiro: mostrar um erro por vez faz
 * a pessoa corrigir, tentar, descobrir o próximo, e desistir na terceira volta.
 */
export function problemasDaCobranca({ valor, descricao, cliente }) {
  const problemas = [];

  if (!Number.isInteger(valor) || valor < VALOR_MINIMO) {
    problemas.push({ campo: 'valor', mensagem: 'O valor mínimo é R$ 1,00.' });
  } else if (valor > VALOR_MAXIMO) {
    problemas.push({ campo: 'valor', mensagem: 'O valor máximo é R$ 50.000,00.' });
  }

  if (!descricao || descricao.trim().length < 3) {
    problemas.push({ campo: 'descricao', mensagem: 'Descreva o que está cobrando.' });
  }

  if (!ehEmailPlausivel(cliente)) {
    problemas.push({ campo: 'cliente', mensagem: 'Informe um e-mail válido.' });
  }

  return problemas;
}

/**
 * Validação de e-mail deliberadamente frouxa.
 *
 * A expressão "correta" tem centenas de caracteres, recusa endereços válidos e
 * aceita inválidos. O único teste que prova que um e-mail existe é mandar
 * mensagem para ele. Aqui só se pega erro de digitação óbvio.
 */
export function ehEmailPlausivel(texto) {
  if (typeof texto !== 'string') return false;

  const limpo = texto.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(limpo);
}

/** Rótulo do estado, como a pessoa lê. */
export const ROTULO_DO_ESTADO = {
  pendente: 'Na fila',
  enviando: 'Enviando',
  confirmada: 'Confirmada',
  recusada: 'Recusada',
};

/**
 * Resumo da fila, para a tela mostrar de relance.
 *
 * Separa o que espera do que falhou: são situações diferentes, e a pessoa
 * precisa saber se deve esperar ou agir.
 */
export function resumir(registros) {
  return {
    total: registros.length,
    aguardando: registros.filter((r) => r.estado === 'pendente' || r.estado === 'enviando')
      .length,
    confirmadas: registros.filter((r) => r.estado === 'confirmada').length,
    recusadas: registros.filter((r) => r.estado === 'recusada').length,
    valorAguardando: registros
      .filter((r) => r.estado === 'pendente' || r.estado === 'enviando')
      .reduce((soma, r) => soma + r.valor, 0),
  };
}
