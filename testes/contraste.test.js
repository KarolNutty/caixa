import { describe, expect, it } from 'vitest';
import {
  avaliar,
  luminancia,
  misturar,
  paraRGB,
  razaoDeContraste,
} from '../nucleo/contraste.js';

describe('leitura de cor', () => {
  it('lê hexadecimal de seis dígitos', () => {
    expect(paraRGB('#4f46e5')).toEqual([79, 70, 229]);
  });

  it('lê hexadecimal de três dígitos', () => {
    expect(paraRGB('#fff')).toEqual([255, 255, 255]);
  });

  it('aceita sem o sustenido', () => {
    expect(paraRGB('4f46e5')).toEqual([79, 70, 229]);
  });

  it('lê o formato funcional', () => {
    // `getComputedStyle` devolve neste formato, então a documentação precisa
    // entendê-lo para ler os tokens de verdade.
    expect(paraRGB('rgb(79, 70, 229)')).toEqual([79, 70, 229]);
  });

  it('lê o formato funcional moderno, com barra', () => {
    expect(paraRGB('rgb(79 70 229 / 0.5)')).toEqual([79, 70, 229]);
  });

  it('cor que não reconhece devolve nulo, em vez de zero', () => {
    // Devolver preto silenciosamente faria a página informar um contraste que
    // ninguém tem, o que é pior que admitir que não sabe.
    expect(paraRGB('rebeccapurple')).toBeNull();
    expect(paraRGB('')).toBeNull();
  });
});

describe('luminância', () => {
  it('branco é 1 e preto é 0', () => {
    expect(luminancia([255, 255, 255])).toBeCloseTo(1, 5);
    expect(luminancia([0, 0, 0])).toBeCloseTo(0, 5);
  });

  it('não é a média dos canais', () => {
    /**
     * O verde pesa muito mais que o azul porque o olho é mais sensível a ele.
     * Usar média simples faria uma paleta azul parecer acessível sem ser.
     */
    const verde = luminancia([0, 255, 0]);
    const azul = luminancia([0, 0, 255]);

    expect(verde).toBeGreaterThan(azul * 5);
  });

  it('a curva não é linear', () => {
    // A diferença entre 10% e 20% de luz é percebida como maior que entre 80% e
    // 90%, e a fórmula reflete isso.
    const escuro = luminancia([26, 26, 26]);
    const meio = luminancia([128, 128, 128]);

    expect(meio / escuro).toBeGreaterThan(10);
  });
});

describe('razão de contraste', () => {
  it('preto sobre branco é o máximo', () => {
    expect(razaoDeContraste('#000', '#fff')).toBeCloseTo(21, 1);
  });

  it('a cor contra ela mesma é 1', () => {
    expect(razaoDeContraste('#4f46e5', '#4f46e5')).toBeCloseTo(1, 5);
  });

  it('a ordem não muda o resultado', () => {
    // Contraste é uma relação, não uma direção: texto claro sobre fundo escuro
    // tem o mesmo número que o inverso.
    const ida = razaoDeContraste('#4f46e5', '#fff');
    const volta = razaoDeContraste('#fff', '#4f46e5');

    expect(ida).toBeCloseTo(volta, 10);
  });

  it('cor inválida devolve nulo', () => {
    expect(razaoDeContraste('inexistente', '#fff')).toBeNull();
  });
});

describe('mistura de translúcido', () => {
  it('opacidade total devolve a cor da frente', () => {
    expect(misturar('#ffffff', 1, '#000000')).toEqual([255, 255, 255]);
  });

  it('opacidade zero devolve o fundo', () => {
    expect(misturar('#ffffff', 0, '#000000')).toEqual([0, 0, 0]);
  });

  it('meio a meio fica no meio', () => {
    expect(misturar('#ffffff', 0.5, '#000000')).toEqual([128, 128, 128]);
  });

  it('texto com opacidade tem contraste menor que a cor declarada', () => {
    /**
     * O erro mais comum ao verificar paleta: a cor declarada passa, e o texto
     * real, que tem opacidade, não. O que vale é o contraste da mistura.
     */
    const cheio = razaoDeContraste('#ffffff', '#4f46e5');
    const misturado = misturar('#ffffff', 0.7, '#4f46e5');
    const comOpacidade = razaoDeContraste(
      `rgb(${misturado.join(',')})`,
      '#4f46e5',
    );

    expect(comOpacidade).toBeLessThan(cheio);
  });
});

describe('veredito', () => {
  it('reconhece os três níveis', () => {
    expect(avaliar(21).nivel).toBe('AAA');
    expect(avaliar(5).nivel).toBe('AA');
    expect(avaliar(2).nivel).toBe('reprovado');
  });

  it('o limite pertence ao lado aprovado', () => {
    // Recusar exatamente 4,5 é o erro clássico de comparação, e derrubaria uma
    // paleta que atende ao mínimo.
    expect(avaliar(4.5).passa).toBe(true);
    expect(avaliar(4.49).passa).toBe(false);
  });

  it('texto grande tem exigência menor', () => {
    // Traço grosso é mais fácil de distinguir, e é por isso que um título pode
    // usar cor que um parágrafo não pode.
    expect(avaliar(3.2, { grande: true }).passa).toBe(true);
    expect(avaliar(3.2, { grande: false }).passa).toBe(false);
  });

  it('cor desconhecida não passa por omissão', () => {
    expect(avaliar(null).passa).toBe(false);
  });
});
