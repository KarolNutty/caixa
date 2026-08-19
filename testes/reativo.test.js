import { describe, expect, it, vi } from 'vitest';
import { derivado, efeito, emLote, observavel } from '../nucleo/reativo.js';

describe('rastreamento de leitura', () => {
  it('roda o efeito na criação', () => {
    const estado = observavel({ a: 1 });
    const visto = [];

    efeito(() => visto.push(estado.a));

    expect(visto).toEqual([1]);
  });

  it('roda de novo quando o campo lido muda', () => {
    const estado = observavel({ a: 1 });
    const visto = [];

    efeito(() => visto.push(estado.a));
    estado.a = 2;

    expect(visto).toEqual([1, 2]);
  });

  it('não roda quando muda um campo que o efeito não lê', () => {
    // É a razão de existir do rastreamento: sem ele, toda mudança acordaria
    // todo efeito, e o custo cresce com o tamanho da aplicação.
    const estado = observavel({ a: 1, b: 1 });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      void estado.a;
    });

    estado.b = 99;

    expect(chamadas).toHaveBeenCalledTimes(1);
  });

  it('atribuir o mesmo valor não dispara nada', () => {
    const estado = observavel({ a: 1 });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      void estado.a;
    });

    estado.a = 1;

    expect(chamadas).toHaveBeenCalledTimes(1);
  });

  it('NaN não conta como mudança contra si mesmo', () => {
    // `NaN !== NaN` é verdadeiro, e por isso a comparação usa `Object.is`.
    const estado = observavel({ a: NaN });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      void estado.a;
    });

    estado.a = NaN;

    expect(chamadas).toHaveBeenCalledTimes(1);
  });
});

describe('dependência condicional', () => {
  it('deixa de acompanhar o campo que parou de ler', () => {
    /**
     * Um efeito que lê `b` só quando `a` é verdadeiro precisa parar de
     * acompanhar `b` assim que `a` vira falso. Sem desinscrever antes de cada
     * execução, ele continuaria acordando por um campo que não usa mais.
     */
    const estado = observavel({ usar: true, valor: 1 });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      if (estado.usar) void estado.valor;
    });

    expect(chamadas).toHaveBeenCalledTimes(1);

    estado.usar = false;
    expect(chamadas).toHaveBeenCalledTimes(2);

    estado.valor = 42;
    expect(chamadas).toHaveBeenCalledTimes(2);
  });
});

describe('cancelamento', () => {
  it('parar o efeito impede execuções futuras', () => {
    // Um efeito vivo depois de a tela sumir segura o estado na memória e
    // escreve num DOM que não existe mais.
    const estado = observavel({ a: 1 });
    const chamadas = vi.fn();

    const parar = efeito(() => {
      chamadas();
      void estado.a;
    });

    parar();
    estado.a = 2;

    expect(chamadas).toHaveBeenCalledTimes(1);
  });
});

describe('lote', () => {
  it('três mudanças viram uma execução', () => {
    const estado = observavel({ a: 1, b: 1, c: 1 });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      void estado.a;
      void estado.b;
      void estado.c;
    });

    emLote(() => {
      estado.a = 2;
      estado.b = 2;
      estado.c = 2;
    });

    expect(chamadas).toHaveBeenCalledTimes(2);
  });

  it('lote aninhado não dispara antes de o externo terminar', () => {
    const estado = observavel({ a: 1, b: 1 });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      void estado.a;
      void estado.b;
    });

    emLote(() => {
      estado.a = 2;
      emLote(() => {
        estado.b = 2;
      });
    });

    expect(chamadas).toHaveBeenCalledTimes(2);
  });

  it('exceção no lote não deixa o sistema travado', () => {
    // Sem o `finally`, um erro aqui deixaria todo lote seguinte acumulando sem
    // nunca executar, e a tela pararia de atualizar sem erro visível.
    const estado = observavel({ a: 1 });
    const chamadas = vi.fn();

    efeito(() => {
      chamadas();
      void estado.a;
    });

    expect(() =>
      emLote(() => {
        estado.a = 2;
        throw new Error('falhou');
      }),
    ).toThrow();

    estado.a = 3;
    expect(chamadas).toHaveBeenCalledTimes(3);
  });
});

describe('valor derivado', () => {
  it('calcula a partir de outros campos', () => {
    const estado = observavel({ preco: 10, quantidade: 3 });
    const total = derivado(() => estado.preco * estado.quantidade);

    expect(total.valor).toBe(30);
  });

  it('recalcula quando a origem muda', () => {
    const estado = observavel({ preco: 10, quantidade: 3 });
    const total = derivado(() => estado.preco * estado.quantidade);

    expect(total.valor).toBe(30);
    estado.quantidade = 4;
    expect(total.valor).toBe(40);
  });

  it('um efeito que lê o derivado acorda quando a origem muda', () => {
    const estado = observavel({ preco: 10 });
    const dobro = derivado(() => estado.preco * 2);
    const visto = [];

    efeito(() => visto.push(dobro.valor));
    estado.preco = 20;

    expect(visto).toEqual([20, 40]);
  });
});

describe('remoção de campo', () => {
  it('apagar um campo avisa quem o lia', () => {
    const estado = observavel({ a: 1 });
    const visto = [];

    efeito(() => visto.push(estado.a));
    delete estado.a;

    expect(visto).toEqual([1, undefined]);
  });
});
