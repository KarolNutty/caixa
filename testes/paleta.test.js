import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { avaliar, razaoDeContraste } from '../nucleo/contraste.js';

/**
 * A paleta é verificada no teste, e não só na página.
 *
 * A documentação mostra o problema para quem abre; o teste **impede** que ele
 * entre. Sem isto, um ajuste de cor derruba o contraste e ninguém percebe até
 * alguém não conseguir ler uma etiqueta.
 *
 * Os valores são lidos do CSS de verdade, então o teste não tem como divergir
 * do produto: mudar o token muda o que é medido aqui.
 */

const css = readFileSync(new URL('../estilos/caixa.css', import.meta.url), 'utf8');

/** Lê os tokens de um bloco, para poder testar os dois temas separados. */
function tokensDe(css, dentroDeMedia = false) {
  const alvo = dentroDeMedia
    ? css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
    : css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));

  const tokens = {};

  for (const achado of alvo.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,8})/gi)) {
    tokens[achado[1]] = achado[2];
  }

  return tokens;
}

/**
 * As combinações que o produto realmente usa.
 *
 * Testar toda cor contra toda cor geraria centenas de pares que não existem na
 * tela, e os reprovados irrelevantes esconderiam os que importam.
 */
const COMBINACOES = [
  ['--tinta', '--superficie', 'Texto principal'],
  ['--tinta-media', '--superficie', 'Texto de apoio'],
  ['--tinta-fraca', '--superficie', 'Rótulos e legendas'],
  ['--tinta', '--fundo', 'Texto sobre a página'],
  ['--tinta-fraca', '--campo', 'Placeholder'],
  ['--acento', '--superficie', 'Link e destaque'],
  ['--acento', '--acento-claro', 'Etiqueta de envio'],
  ['--sucesso', '--sucesso-claro', 'Etiqueta confirmada'],
  ['--atencao', '--atencao-claro', 'Etiqueta na fila'],
  ['--erro', '--erro-claro', 'Etiqueta recusada'],
  ['--erro', '--superficie', 'Mensagem de erro'],
];

describe.each([
  ['claro', tokensDe(css, false)],
  ['escuro', tokensDe(css, true)],
])('paleta do tema %s', (nome, tokens) => {
  it('define todos os tokens usados', () => {
    const necessarios = new Set(COMBINACOES.flatMap(([a, b]) => [a, b]));

    for (const token of necessarios) {
      expect(tokens[token], `${token} não está definido no tema ${nome}`).toBeTruthy();
    }
  });

  it.each(COMBINACOES)('%s sobre %s (%s) passa no mínimo', (texto, fundo, uso) => {
    const razao = razaoDeContraste(tokens[texto], tokens[fundo]);
    const veredito = avaliar(razao);

    expect(
      veredito.passa,
      `${uso} no tema ${nome}: ${razao?.toFixed(2)}, mínimo 4.5`,
    ).toBe(true);
  });
});

describe('o botão principal', () => {
  it('o texto sobre o acento é legível nos dois temas', () => {
    // O botão usa branco no tema claro e o fundo da página no escuro: são cores
    // diferentes, e as duas precisam ser verificadas.
    const claro = tokensDe(css, false);
    const escuro = tokensDe(css, true);

    expect(avaliar(razaoDeContraste('#ffffff', claro['--acento'])).passa).toBe(true);
    expect(
      avaliar(razaoDeContraste(escuro['--fundo'], escuro['--acento'])).passa,
    ).toBe(true);
  });
});
