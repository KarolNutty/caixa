// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  digitosAntesDe,
  formatarBRL,
  paraCentavos,
  posicaoDoCursor,
  somenteDigitos,
} from '../componentes/campo-valor.js';

describe('dinheiro é contagem, não medida', () => {
  it('guarda centavos em inteiro', () => {
    /**
     * `0.1 + 0.2` dá `0.30000000000000004` em ponto flutuante. Num sistema de
     * cobrança essa diferença vira divergência de centavo no fechamento do dia.
     */
    expect(paraCentavos('1234')).toBe(1234);
    expect(Number.isInteger(paraCentavos('1234'))).toBe(true);
  });

  it('soma de centavos é exata', () => {
    const dez = paraCentavos('10');
    const vinte = paraCentavos('20');

    expect(dez + vinte).toBe(30);
  });

  it('ignora o que não é dígito', () => {
    expect(paraCentavos('R$ 1.234,56')).toBe(123456);
  });

  it('campo vazio vale zero', () => {
    expect(paraCentavos('')).toBe(0);
    expect(paraCentavos('R$ ,')).toBe(0);
  });

  it('corta valores absurdos em vez de perder precisão', () => {
    // `Number` perde precisão acima de 2^53, e guardar um número errado em
    // silêncio é pior que recusar o excesso.
    const colado = '9'.repeat(30);
    expect(Number.isSafeInteger(paraCentavos(colado))).toBe(true);
  });
});

describe('formatação', () => {
  it('mostra em reais', () => {
    expect(formatarBRL(123456).replace(/\u00a0/g, ' ')).toBe('R$ 1.234,56');
  });

  it('zero tem formato válido', () => {
    expect(formatarBRL(0).replace(/\u00a0/g, ' ')).toBe('R$ 0,00');
  });

  it('centavos sozinhos aparecem certo', () => {
    expect(formatarBRL(5).replace(/\u00a0/g, ' ')).toBe('R$ 0,05');
  });
});

describe('posição do cursor', () => {
  /**
   * O jeito ingênuo, `campo.value = formatar(campo.value)`, joga o cursor para
   * o fim a cada tecla. Quem edita no meio de um valor já digitado perde o
   * lugar e precisa reposicionar depois de cada caractere.
   *
   * A conta que resolve: quantos DÍGITOS existem antes do cursor. Separadores
   * mudam de lugar; a posição relativa aos dígitos, não.
   */

  it('conta os dígitos antes do cursor', () => {
    expect(digitosAntesDe('R$ 1.234,56', 6)).toBe(2);
  });

  it('separador não conta como dígito', () => {
    expect(digitosAntesDe('R$ 1.234,56', 5)).toBe(1);
  });

  it('recoloca o cursor depois do mesmo dígito', () => {
    /**
     * A propriedade que importa: depois de reformatar, a quantidade de dígitos
     * à esquerda do cursor é a mesma de antes. É isso que faz a edição no meio
     * do valor parecer natural.
     */
    const texto = 'R$ 12.345,60';
    const posicao = posicaoDoCursor(texto, 3);

    expect(digitosAntesDe(texto, posicao)).toBe(3);
  });

  it('o cursor cai logo depois do dígito, e não antes do separador', () => {
    // Parar antes do ponto faria a próxima tecla inserir no lugar errado.
    const texto = 'R$ 12.345,60';
    const posicao = posicaoDoCursor(texto, 2);

    expect(texto[posicao - 1]).toBe('2');
  });

  it('a propriedade vale para qualquer posição', () => {
    const texto = 'R$ 1.234,56';

    for (let d = 1; d <= 6; d += 1) {
      expect(digitosAntesDe(texto, posicaoDoCursor(texto, d))).toBe(d);
    }
  });

  it('cursor no começo continua no começo', () => {
    expect(posicaoDoCursor('R$ 1.234,56', 0)).toBe('R$ 1.234,56'.length);
  });

  it('mais dígitos pedidos que existentes vai para o fim', () => {
    // Acontece ao apagar: o texto novo tem menos dígitos que o antigo.
    expect(posicaoDoCursor('R$ 0,05', 99)).toBe('R$ 0,05'.length);
  });

  it('a posição sempre cai dentro do texto', () => {
    const texto = 'R$ 1.234,56';

    for (let d = 0; d <= 12; d += 1) {
      const posicao = posicaoDoCursor(texto, d);
      expect(posicao).toBeGreaterThanOrEqual(0);
      expect(posicao).toBeLessThanOrEqual(texto.length);
    }
  });
});

describe('extração de dígitos', () => {
  it('tira tudo que não é número', () => {
    expect(somenteDigitos('R$ 1.234,56')).toBe('123456');
  });

  it('texto sem número devolve vazio', () => {
    expect(somenteDigitos('abc')).toBe('');
  });
});

describe('o componente', () => {
  it('digitar mantém o cursor no lugar relativo', async () => {
    await import('../componentes/campo-valor.js');

    const campo = document.createElement('campo-valor');
    document.body.append(campo);

    const entrada = campo.shadowRoot.querySelector('input');

    entrada.value = 'R$ 1.234,56';
    entrada.setSelectionRange(6, 6);
    entrada.dispatchEvent(new Event('input'));

    // Depois de reformatar, o cursor continua depois do segundo dígito.
    expect(digitosAntesDe(entrada.value, entrada.selectionStart)).toBe(2);

    campo.remove();
  });

  it('avisa quem escuta quando o valor muda', async () => {
    await import('../componentes/campo-valor.js');

    const campo = document.createElement('campo-valor');
    document.body.append(campo);

    let recebido = null;
    campo.addEventListener('valor', (evento) => {
      recebido = evento.detail.centavos;
    });

    const entrada = campo.shadowRoot.querySelector('input');
    entrada.value = '4990';
    entrada.dispatchEvent(new Event('input'));

    expect(recebido).toBe(4990);
    campo.remove();
  });

  it('valor negativo vira zero', () => {
    const campo = document.createElement('campo-valor');
    document.body.append(campo);

    campo.valor = -500;

    expect(campo.valor).toBe(0);
    campo.remove();
  });
});
