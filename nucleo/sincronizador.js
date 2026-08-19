import {
  ESTADOS,
  aplicarResultado,
  listar,
  prontasParaEnvio,
  salvar,
} from './fila.js';

/**
 * Sincronizador.
 *
 * Junta a fila e a rede: pega o que está pronto, envia, aplica o resultado.
 *
 * Duas coisas o tornam menos óbvio do que parece.
 *
 * **Abas.** Com três abas abertas, três sincronizadores tentariam enviar a
 * mesma cobrança ao mesmo tempo. A chave de idempotência impede a cobrança
 * dupla no servidor, mas não impede o desperdício nem a corrida ao gravar o
 * resultado. A saída é eleger uma aba para trabalhar e as outras só olharem.
 *
 * **Envio em série, não em paralelo.** Disparar tudo de uma vez é mais rápido
 * e perde a ordem: quem pagou primeiro pode ser cobrado depois, e num extrato
 * isso parece erro. Além disso, uma rajada logo após a rede voltar é o pior
 * momento para pressionar o servidor.
 */

const CANAL = 'caixa-sincronizacao';

/**
 * Eleição de líder entre abas.
 *
 * Usa `navigator.locks`, que o navegador resolve sozinho: quem pega a trava
 * fica com ela até a aba fechar ou travar, e aí outra assume automaticamente.
 * Fazer isso à mão exigiria pulsos periódicos e um tempo de espera arbitrário,
 * e uma aba lenta seria confundida com uma aba morta.
 */
export function criarEleicao({ locks = globalThis.navigator?.locks } = {}) {
  let souLider = false;
  let liberar = null;

  return {
    get lider() {
      return souLider;
    },

    async disputar(aoAssumir) {
      // Sem a API de travas, cada aba trabalha por conta. É pior, e é melhor
      // que não sincronizar nada: a idempotência ainda protege o servidor.
      if (!locks) {
        souLider = true;
        aoAssumir?.();
        return;
      }

      locks.request(CANAL, () => {
        souLider = true;
        aoAssumir?.();

        // A promessa só resolve quando `liberar` é chamado. Enquanto ela
        // estiver pendente, a trava é desta aba.
        return new Promise((resolver) => {
          liberar = resolver;
        });
      });
    },

    abrirMao() {
      souLider = false;
      liberar?.();
      liberar = null;
    },
  };
}

/**
 * Aviso entre abas.
 *
 * A aba que não trabalha ainda precisa atualizar a tela quando a líder
 * confirma um pagamento. Sem isso, a pessoa vê "enviando" para sempre numa
 * aba enquanto a outra já mostrou o comprovante.
 */
export function criarCanal({ BroadcastChannel = globalThis.BroadcastChannel } = {}) {
  const canal = BroadcastChannel ? new BroadcastChannel(CANAL) : null;

  return {
    avisar(mensagem) {
      canal?.postMessage(mensagem);
    },

    aoReceber(fn) {
      if (!canal) return () => {};

      const ouvinte = (evento) => fn(evento.data);
      canal.addEventListener('message', ouvinte);

      return () => canal.removeEventListener('message', ouvinte);
    },

    fechar() {
      canal?.close();
    },
  };
}

/**
 * Percorre a fila uma vez.
 *
 * Devolve o que aconteceu, para quem chamou decidir o que mostrar. Não agenda
 * nada nem mexe em temporizador: isso fica com o laço de fora, e é o que
 * permite testar esta parte sem esperar o tempo passar.
 */
export async function passarPelaFila(bd, enviar, { agora = Date.now(), aoMudar } = {}) {
  const registros = await listar(bd);
  const prontas = prontasParaEnvio(registros, agora);

  const resultados = [];

  for (const registro of prontas) {
    // Marca como enviando ANTES da rede, para a tela mostrar o que está
    // acontecendo e para outra passada não pegar a mesma cobrança.
    const enviando = { ...registro, estado: ESTADOS.ENVIANDO };
    await salvar(bd, enviando);
    aoMudar?.(enviando);

    let resultado;

    try {
      resultado = await enviar(registro);
    } catch (erro) {
      // Exceção da camada de rede é falha temporária: `fetch` só rejeita
      // quando a requisição não chegou a completar.
      resultado = { ok: false, status: 0, mensagem: erro?.message ?? 'Sem conexão.' };
    }

    const atualizado = aplicarResultado(
      { ...enviando, estado: ESTADOS.PENDENTE },
      resultado,
      Date.now(),
    );

    await salvar(bd, atualizado);
    aoMudar?.(atualizado);

    resultados.push(atualizado);
  }

  return resultados;
}

/**
 * O laço que mantém a fila andando.
 *
 * Dispara ao voltar a conexão, ao a aba ficar visível de novo, e a cada
 * intervalo. Os três existem por motivos diferentes:
 *
 * O evento `online` é o mais rápido, e mente: o navegador diz que há conexão
 * quando existe uma interface de rede, não quando a internet responde.
 *
 * `visibilitychange` pega o caso de a pessoa voltar para a aba depois de horas,
 * quando os temporizadores estavam suspensos.
 *
 * O intervalo é a rede de segurança para tudo que os dois anteriores não
 * cobrem, incluindo o navegador ter mentido no `online`.
 */
export function iniciarSincronizacao({
  bd,
  enviar,
  aoMudar,
  intervalo = 15_000,
  janela = globalThis,
  documento = globalThis.document,
}) {
  let rodando = false;
  let parado = false;

  async function tentar() {
    // Uma passada de cada vez: duas em paralelo pegariam a mesma cobrança
    // entre a leitura e a marcação.
    if (rodando || parado) return;

    rodando = true;

    try {
      await passarPelaFila(bd, enviar, { aoMudar });
    } finally {
      rodando = false;
    }
  }

  /**
   * A volta da conexão zera a espera.
   *
   * A espera existe para não martelar uma rede que caiu. Quando o navegador
   * avisa que ela voltou, essa é a única informação nova que temos, e continuar
   * esperando dois minutos ignora justamente o que mudou.
   *
   * Só as pendentes: recusada não volta a ser tentada por causa de rede.
   */
  const aoVoltarConexao = () => {
    void (async () => {
      const registros = await listar(bd);

      for (const registro of registros) {
        if (registro.estado === ESTADOS.PENDENTE && registro.proximaTentativaEm > 0) {
          await salvar(bd, { ...registro, proximaTentativaEm: 0 });
        }
      }

      await tentar();
    })();
  };
  const aoMudarVisibilidade = () => {
    if (documento?.visibilityState === 'visible') void tentar();
  };

  janela.addEventListener?.('online', aoVoltarConexao);
  documento?.addEventListener?.('visibilitychange', aoMudarVisibilidade);

  const relogio = setInterval(() => void tentar(), intervalo);

  void tentar();

  return () => {
    parado = true;
    clearInterval(relogio);
    janela.removeEventListener?.('online', aoVoltarConexao);
    documento?.removeEventListener?.('visibilitychange', aoMudarVisibilidade);
  };
}
