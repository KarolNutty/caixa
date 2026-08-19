import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADOS, abrirBanco, enfileirar, listar } from '../nucleo/fila.js';
import {
  criarEleicao,
  iniciarSincronizacao,
  passarPelaFila,
} from '../nucleo/sincronizador.js';

let bd;

beforeEach(async () => {
  indexedDB = new IDBFactory();
  bd = await abrirBanco();
});

function cobranca(chave, valor = 1000) {
  return { chave, valor, descricao: 'Assinatura', cliente: 'ana@exemplo.com' };
}

describe('passagem pela fila', () => {
  it('envia o que está pendente e confirma', async () => {
    await enfileirar(bd, cobranca('a'));

    const enviar = vi.fn(async () => ({ ok: true, id: 'pay_a' }));
    const resultados = await passarPelaFila(bd, enviar);

    expect(enviar).toHaveBeenCalledTimes(1);
    expect(resultados[0].estado).toBe(ESTADOS.CONFIRMADA);
  });

  it('mantém a ordem de criação', async () => {
    /**
     * Quem pagou primeiro é cobrado primeiro. Disparar tudo em paralelo seria
     * mais rápido e embaralharia o extrato, o que parece erro para quem lê.
     */
    await enfileirar(bd, cobranca('primeira'));
    await new Promise((r) => setTimeout(r, 2));
    await enfileirar(bd, cobranca('segunda'));

    const ordem = [];
    const enviar = vi.fn(async (registro) => {
      ordem.push(registro.chave);
      return { ok: true };
    });

    await passarPelaFila(bd, enviar);

    expect(ordem).toEqual(['primeira', 'segunda']);
  });

  it('a mesma chave de idempotência vai em toda tentativa', async () => {
    /**
     * É o que impede a cobrança dupla quando a resposta se perde depois de o
     * servidor já ter processado. Gerar chave nova a cada tentativa
     * transformaria uma retentativa em segunda cobrança.
     */
    await enfileirar(bd, cobranca('estavel'));

    const chaves = [];
    const enviar = vi.fn(async (registro) => {
      chaves.push(registro.chave);
      return { ok: false, status: 0 };
    });

    await passarPelaFila(bd, enviar);

    const registros = await listar(bd);
    registros[0].proximaTentativaEm = 0;
    const { salvar } = await import('../nucleo/fila.js');
    await salvar(bd, registros[0]);

    await passarPelaFila(bd, enviar);

    expect(chaves).toEqual(['estavel', 'estavel']);
  });

  it('falha de rede devolve para a fila', async () => {
    await enfileirar(bd, cobranca('a'));

    const enviar = async () => {
      throw new Error('sem rede');
    };

    const resultados = await passarPelaFila(bd, enviar);

    expect(resultados[0].estado).toBe(ESTADOS.PENDENTE);
    expect(resultados[0].tentativas).toBe(1);
  });

  it('exceção do fetch conta como temporária, e não como recusa', async () => {
    // `fetch` só rejeita quando a requisição não completou. Tratar isso como
    // recusa jogaria fora um pagamento que talvez passasse na próxima.
    await enfileirar(bd, cobranca('a'));

    const resultados = await passarPelaFila(bd, async () => {
      throw new TypeError('Failed to fetch');
    });

    expect(resultados[0].estado).toBe(ESTADOS.PENDENTE);
  });

  it('cartão recusado sai da fila', async () => {
    await enfileirar(bd, cobranca('a'));

    const resultados = await passarPelaFila(bd, async () => ({
      ok: false,
      status: 402,
      mensagem: 'Cartão recusado.',
    }));

    expect(resultados[0].estado).toBe(ESTADOS.RECUSADA);
  });

  it('avisa a tela antes e depois do envio', async () => {
    // Sem o aviso de "enviando", a tela fica parada durante a chamada e a
    // pessoa não sabe se o toque funcionou.
    await enfileirar(bd, cobranca('a'));

    const estados = [];
    await passarPelaFila(bd, async () => ({ ok: true }), {
      aoMudar: (registro) => estados.push(registro.estado),
    });

    expect(estados).toEqual([ESTADOS.ENVIANDO, ESTADOS.CONFIRMADA]);
  });

  it('não mexe no que está em espera', async () => {
    const registro = await enfileirar(bd, cobranca('a'));
    const { salvar } = await import('../nucleo/fila.js');
    await salvar(bd, { ...registro, proximaTentativaEm: Date.now() + 60_000 });

    const enviar = vi.fn();
    await passarPelaFila(bd, enviar);

    expect(enviar).not.toHaveBeenCalled();
  });

  it('fila vazia não chama a rede', async () => {
    const enviar = vi.fn();
    await passarPelaFila(bd, enviar);

    expect(enviar).not.toHaveBeenCalled();
  });
});

describe('eleição entre abas', () => {
  it('sem a API de travas, cada aba trabalha por conta', async () => {
    // Pior que coordenar, melhor que não sincronizar: a idempotência ainda
    // protege o servidor da cobrança dupla.
    const eleicao = criarEleicao({ locks: undefined });
    const assumiu = vi.fn();

    await eleicao.disputar(assumiu);

    expect(eleicao.lider).toBe(true);
    expect(assumiu).toHaveBeenCalled();
  });

  it('quem pega a trava vira líder', async () => {
    const locks = {
      request: (_nome, fn) => {
        void fn();
      },
    };

    const eleicao = criarEleicao({ locks });
    await eleicao.disputar();

    expect(eleicao.lider).toBe(true);
  });

  it('abrir mão libera a trava para outra aba', async () => {
    let liberada = false;

    const locks = {
      request: (_nome, fn) => {
        void fn().then(() => {
          liberada = true;
        });
      },
    };

    const eleicao = criarEleicao({ locks });
    await eleicao.disputar();

    eleicao.abrirMao();
    await Promise.resolve();

    expect(eleicao.lider).toBe(false);
    expect(liberada).toBe(true);
  });
});

describe('laço de sincronização', () => {
  it('tenta assim que começa', async () => {
    await enfileirar(bd, cobranca('a'));

    const enviar = vi.fn(async () => ({ ok: true }));
    const parar = iniciarSincronizacao({
      bd,
      enviar,
      janela: { addEventListener() {}, removeEventListener() {} },
      documento: null,
    });

    await new Promise((r) => setTimeout(r, 20));
    parar();

    expect(enviar).toHaveBeenCalled();
  });

  it('duas passadas não rodam ao mesmo tempo', async () => {
    /**
     * Em paralelo, as duas leem a fila antes de qualquer marcação e pegam a
     * mesma cobrança. A idempotência salvaria o servidor, mas o desperdício e a
     * corrida ao gravar continuariam.
     */
    await enfileirar(bd, cobranca('a'));

    let emVoo = 0;
    let maximo = 0;

    const enviar = async () => {
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      await new Promise((r) => setTimeout(r, 10));
      emVoo -= 1;
      return { ok: false, status: 0 };
    };

    const parar = iniciarSincronizacao({
      bd,
      enviar,
      intervalo: 1,
      janela: { addEventListener() {}, removeEventListener() {} },
      documento: null,
    });

    await new Promise((r) => setTimeout(r, 60));
    parar();

    expect(maximo).toBe(1);
  });

  it('parar impede tentativas futuras', async () => {
    await enfileirar(bd, cobranca('a'));

    const enviar = vi.fn(async () => ({ ok: false, status: 0 }));
    const parar = iniciarSincronizacao({
      bd,
      enviar,
      intervalo: 5,
      janela: { addEventListener() {}, removeEventListener() {} },
      documento: null,
    });

    await new Promise((r) => setTimeout(r, 20));
    parar();

    const antes = enviar.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));

    expect(enviar.mock.calls.length).toBe(antes);
  });

  it('a volta da conexão zera a espera e tenta de novo', async () => {
    /**
     * A espera existe para não martelar uma rede que caiu. Quando o navegador
     * avisa que ela voltou, essa é a única informação nova que temos, e
     * continuar esperando dois minutos ignora justamente o que mudou.
     */
    await enfileirar(bd, cobranca('a'));

    const ouvintes = {};
    const janela = {
      addEventListener: (evento, fn) => {
        ouvintes[evento] = fn;
      },
      removeEventListener() {},
    };

    const enviar = vi.fn(async () => ({ ok: false, status: 0 }));
    const parar = iniciarSincronizacao({ bd, enviar, janela, documento: null });

    await new Promise((r) => setTimeout(r, 20));
    const antes = enviar.mock.calls.length;

    ouvintes.online?.();
    await new Promise((r) => setTimeout(r, 20));

    parar();
    expect(enviar.mock.calls.length).toBeGreaterThan(antes);
  });
});
