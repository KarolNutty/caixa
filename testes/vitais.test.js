// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIMITES,
  classificar,
  formatar,
  medirCLS,
  medirINP,
  medirLCP,
} from '../nucleo/vitais.js';

/**
 * As métricas são testadas com entradas falsas, e não com um navegador de
 * verdade.
 *
 * O que precisa de teste aqui não é o `PerformanceObserver`, que é do
 * navegador. É a regra em cima do que ele emite: qual valor vale, o que é
 * descartado, e como a janela do CLS funciona. É aí que a implementação à mão
 * costuma errar.
 */

/** Um observador falso que deixa o teste emitir entradas quando quiser. */
function prepararObservador() {
  const registrados = new Map();

  globalThis.PerformanceObserver = class {
    constructor(callback) {
      this.callback = callback;
    }

    observe({ type }) {
      registrados.set(type, this.callback);
    }

    disconnect() {}
  };

  return {
    emitir(tipo, ...entradas) {
      registrados.get(tipo)?.({ getEntries: () => entradas });
    },
  };
}

let observador;

beforeEach(() => {
  observador = prepararObservador();
});

describe('classificação', () => {
  it('separa os três níveis', () => {
    expect(classificar('LCP', 2000)).toBe('bom');
    expect(classificar('LCP', 3000)).toBe('melhorar');
    expect(classificar('LCP', 5000)).toBe('ruim');
  });

  it('o limite pertence ao lado bom', () => {
    // Recusar exatamente 2500 marcaria como ruim uma página que atende ao
    // critério do Google.
    expect(classificar('LCP', LIMITES.LCP.bom)).toBe('bom');
  });

  it('cada métrica tem o próprio limite', () => {
    // 200ms é bom para INP e péssimo se fosse CLS: os números não são
    // intercambiáveis.
    expect(classificar('INP', 200)).toBe('bom');
    expect(classificar('CLS', 0.05)).toBe('bom');
    expect(classificar('CLS', 0.3)).toBe('ruim');
  });

  it('métrica desconhecida não inventa veredito', () => {
    expect(classificar('INVENTADA', 1)).toBe('desconhecido');
    expect(classificar('LCP', null)).toBe('desconhecido');
  });
});

describe('maior conteúdo pintado', () => {
  it('vale a última emissão, não a primeira', () => {
    /**
     * O navegador emite várias vezes conforme descobre elementos maiores.
     * Guardar a primeira reportaria um número bom e errado.
     */
    const visto = [];
    medirLCP((dados) => visto.push(dados.valor));

    observador.emitir('largest-contentful-paint', { startTime: 800, element: null });
    observador.emitir('largest-contentful-paint', { startTime: 2100, element: null });

    expect(visto.at(-1)).toBe(2100);
  });
});

describe('deslocamento acumulado', () => {
  it('soma os deslocamentos da mesma janela', () => {
    let atual = 0;
    medirCLS((dados) => {
      atual = dados.valor;
    });

    observador.emitir('layout-shift', { value: 0.05, startTime: 100, hadRecentInput: false });
    observador.emitir('layout-shift', { value: 0.03, startTime: 300, hadRecentInput: false });

    expect(atual).toBeCloseTo(0.08, 5);
  });

  it('ignora deslocamento causado por interação', () => {
    /**
     * Abrir um acordeão empurra o conteúdo, e isso é esperado: a pessoa pediu.
     * Contar isso puniria interface interativa e premiaria página estática.
     */
    let atual = 0;
    medirCLS((dados) => {
      atual = dados.valor;
    });

    observador.emitir('layout-shift', { value: 0.5, startTime: 100, hadRecentInput: true });

    expect(atual).toBe(0);
  });

  it('abre nova janela depois de um segundo de silêncio', () => {
    /**
     * A métrica é a maior janela, não a soma de tudo. Somar puniria uma página
     * aberta por horas, onde cada rolagem acrescentaria um pouco.
     */
    let atual = 0;
    medirCLS((dados) => {
      atual = dados.valor;
    });

    observador.emitir('layout-shift', { value: 0.06, startTime: 100, hadRecentInput: false });
    // Mais de um segundo depois: janela nova.
    observador.emitir('layout-shift', { value: 0.04, startTime: 2000, hadRecentInput: false });

    // Vale a maior janela, que é a primeira, e não 0.10.
    expect(atual).toBeCloseTo(0.06, 5);
  });

  it('a janela também fecha depois de cinco segundos contínuos', () => {
    let atual = 0;
    medirCLS((dados) => {
      atual = dados.valor;
    });

    // Deslocamentos a cada 900ms: nunca há um segundo de silêncio, mas a
    // janela estoura em cinco segundos.
    for (let t = 0; t <= 6000; t += 900) {
      observador.emitir('layout-shift', {
        value: 0.02,
        startTime: t,
        hadRecentInput: false,
      });
    }

    // Sem o corte de cinco segundos, o total seria 0.16.
    expect(atual).toBeLessThan(0.16);
  });

  it('só reporta quando o pior aumenta', () => {
    const visto = [];
    medirCLS((dados) => visto.push(dados.valor));

    observador.emitir('layout-shift', { value: 0.10, startTime: 100, hadRecentInput: false });
    observador.emitir('layout-shift', { value: 0.01, startTime: 3000, hadRecentInput: false });

    expect(visto).toHaveLength(1);
  });
});

describe('resposta à interação', () => {
  it('reporta a pior interação, não a média', () => {
    /**
     * Uma interação lenta entre vinte rápidas é o que a pessoa lembra. A média
     * esconderia exatamente o caso que incomoda.
     */
    const visto = [];
    medirINP((dados) => visto.push(dados.valor));

    observador.emitir('event', { interactionId: 1, duration: 40, name: 'click' });
    observador.emitir('event', { interactionId: 2, duration: 320, name: 'click' });
    observador.emitir('event', { interactionId: 3, duration: 60, name: 'click' });

    expect(visto.at(-1)).toBe(320);
  });

  it('ignora evento sem identificador de interação', () => {
    // Sem `interactionId` não houve interação de verdade: é evento sintético
    // ou disparado por código.
    const visto = [];
    medirINP((dados) => visto.push(dados.valor));

    observador.emitir('event', { interactionId: 0, duration: 900, name: 'scroll' });

    expect(visto).toHaveLength(0);
  });
});

describe('ambiente sem suporte', () => {
  it('não quebra quando o observador não existe', () => {
    // Navegador antigo não implementa todos os tipos, e falhar aqui derrubaria
    // a página por causa de uma métrica.
    delete globalThis.PerformanceObserver;

    expect(() => medirLCP(() => {})).not.toThrow();
  });

  it('não quebra quando o tipo é desconhecido', () => {
    globalThis.PerformanceObserver = class {
      observe() {
        throw new TypeError('tipo não suportado');
      }

      disconnect() {}
    };

    expect(() => medirINP(() => {})).not.toThrow();
  });
});

describe('formatação', () => {
  it('milissegundos abaixo de um segundo', () => {
    expect(formatar('LCP', 847)).toBe('847 ms');
  });

  it('segundos acima disso', () => {
    expect(formatar('LCP', 2340)).toBe('2.34 s');
  });

  it('CLS não tem unidade e usa três casas', () => {
    expect(formatar('CLS', 0.0523)).toBe('0.052');
  });

  it('valor ausente vira travessão, e não zero', () => {
    // Zero significaria "perfeito", quando o certo é "ainda não medimos".
    expect(formatar('LCP', null)).toBe('—');
  });
});
