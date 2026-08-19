import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADOS, abrirBanco, listar, salvar } from '../nucleo/fila.js';
import { passarPelaFila } from '../nucleo/sincronizador.js';
import { enfileirar } from '../nucleo/fila.js';
import { novaChave } from '../nucleo/cobranca.js';

let bd;

beforeEach(async () => {
  indexedDB = new IDBFactory();
  bd = await abrirBanco();
});

/**
 * Um servidor de mentira que se comporta como um de verdade.
 *
 * Guarda o que processou por chave de idempotência e devolve o mesmo resultado
 * para a mesma chave. É o comportamento que a fila depende, e testá-lo aqui é o
 * que prova que as duas pontas se encontram.
 */
function servidorFalso({ falharAte = 0 } = {}) {
  const processadas = new Map();
  let chamadas = 0;

  return {
    get chamadas() {
      return chamadas;
    },

    get cobrancasCriadas() {
      return processadas.size;
    },

    async enviar(registro) {
      chamadas += 1;

      if (processadas.has(registro.chave)) {
        return { ok: true, id: processadas.get(registro.chave), repetida: true };
      }

      if (chamadas <= falharAte) {
        return { ok: false, status: 503, mensagem: 'Indisponível.' };
      }

      const id = `pay_${processadas.size + 1}`;
      processadas.set(registro.chave, id);
      return { ok: true, id };
    },
  };
}

describe('o pagamento não se perde', () => {
  it('sobrevive a três falhas seguidas e é cobrado uma vez só', async () => {
    /**
     * O caso que motiva o projeto inteiro: rede instável durante a cobrança.
     * O pedido precisa chegar, e precisa chegar uma vez.
     */
    const servidor = servidorFalso({ falharAte: 3 });
    await enfileirar(bd, {
      chave: novaChave(),
      valor: 4990,
      descricao: 'Plano',
      cliente: 'ana@exemplo.com',
    });

    // Quatro passadas: as três primeiras falham, a quarta passa.
    for (let volta = 0; volta < 4; volta += 1) {
      const [registro] = await listar(bd);
      if (registro.estado === ESTADOS.CONFIRMADA) break;

      await salvar(bd, { ...registro, proximaTentativaEm: 0 });
      await passarPelaFila(bd, servidor.enviar);
    }

    const [final] = await listar(bd);

    expect(final.estado).toBe(ESTADOS.CONFIRMADA);
    expect(servidor.chamadas).toBe(4);
    expect(servidor.cobrancasCriadas).toBe(1);
  });

  it('resposta perdida depois do processamento não cobra duas vezes', async () => {
    /**
     * O caso mais difícil, e a razão de existir da chave de idempotência: o
     * servidor processou, a resposta não chegou, e o cliente tenta de novo.
     *
     * Sem a chave, isso é uma segunda cobrança. Com ela, o servidor reconhece
     * e devolve o resultado da primeira.
     */
    const processadas = new Map();
    let primeiraChamada = true;

    const enviar = async (registro) => {
      if (!processadas.has(registro.chave)) {
        processadas.set(registro.chave, `pay_${processadas.size + 1}`);
      }

      // A primeira resposta se perde no caminho de volta, DEPOIS de o servidor
      // ter processado.
      if (primeiraChamada) {
        primeiraChamada = false;
        return { ok: false, status: 0, mensagem: 'Conexão caiu.' };
      }

      return { ok: true, id: processadas.get(registro.chave) };
    };

    await enfileirar(bd, {
      chave: novaChave(),
      valor: 1000,
      descricao: 'Plano',
      cliente: 'ana@exemplo.com',
    });

    await passarPelaFila(bd, enviar);

    const [emEspera] = await listar(bd);
    await salvar(bd, { ...emEspera, proximaTentativaEm: 0 });

    await passarPelaFila(bd, enviar);

    const [final] = await listar(bd);

    expect(final.estado).toBe(ESTADOS.CONFIRMADA);
    // O que importa: uma cobrança, não duas.
    expect(processadas.size).toBe(1);
  });

  it('a fila continua depois de reabrir o banco', async () => {
    // Equivale a fechar a aba no meio e voltar depois.
    const servidor = servidorFalso();

    await enfileirar(bd, {
      chave: novaChave(),
      valor: 2500,
      descricao: 'Consulta',
      cliente: 'bruno@exemplo.com',
    });

    bd.close();

    const outroBd = await abrirBanco();
    await passarPelaFila(outroBd, servidor.enviar);

    const [registro] = await listar(outroBd);

    expect(registro.estado).toBe(ESTADOS.CONFIRMADA);
  });

  it('várias cobranças mantêm a ordem e nenhuma se perde', async () => {
    const servidor = servidorFalso();

    for (let i = 0; i < 5; i += 1) {
      await enfileirar(bd, {
        chave: novaChave(),
        valor: 1000 + i,
        descricao: `Cobrança ${i}`,
        cliente: 'ana@exemplo.com',
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const ordem = [];
    await passarPelaFila(bd, async (registro) => {
      ordem.push(registro.valor);
      return servidor.enviar(registro);
    });

    expect(ordem).toEqual([1000, 1001, 1002, 1003, 1004]);

    const registros = await listar(bd);
    expect(registros.every((r) => r.estado === ESTADOS.CONFIRMADA)).toBe(true);
  });

  it('uma recusada não impede as outras de passar', async () => {
    // Sem isso, um cartão sem saldo travaria a fila inteira.
    await enfileirar(bd, {
      chave: 'ruim',
      valor: 1000,
      descricao: 'Recusada',
      cliente: 'a@b.co',
    });
    await new Promise((r) => setTimeout(r, 2));
    await enfileirar(bd, {
      chave: 'boa',
      valor: 2000,
      descricao: 'Aceita',
      cliente: 'a@b.co',
    });

    await passarPelaFila(bd, async (registro) =>
      registro.chave === 'ruim'
        ? { ok: false, status: 402, mensagem: 'Sem saldo.' }
        : { ok: true, id: 'pay_ok' },
    );

    const registros = await listar(bd);
    const porChave = Object.fromEntries(registros.map((r) => [r.chave, r.estado]));

    expect(porChave.ruim).toBe(ESTADOS.RECUSADA);
    expect(porChave.boa).toBe(ESTADOS.CONFIRMADA);
  });
});
