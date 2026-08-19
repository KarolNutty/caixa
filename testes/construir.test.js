import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * O pacote de produção precisa funcionar.
 *
 * É o teste que importa mais num minificador: economizar bytes é fácil, e
 * economizar sem quebrar é o trabalho. Um minificador que corrompe um arquivo
 * em cada cem falha de um jeito que só aparece em produção.
 */

const RAIZ = new URL('..', import.meta.url);

beforeAll(() => {
  execFileSync('node', ['construir.js'], { cwd: RAIZ.pathname, stdio: 'ignore' });
}, 30_000);

afterAll(async () => {
  await rm(new URL('publico', RAIZ), { recursive: true, force: true });
});

describe('o pacote gerado', () => {
  /*
   * O componente fica de fora desta lista.
   *
   * Ele estende `HTMLElement`, que não existe em Node, e importá-lo aqui
   * falharia por ambiente e não por minificação. Ele é verificado no teste do
   * próprio componente, que roda em jsdom.
   */
  it.each([
    'nucleo/reativo.js',
    'nucleo/fila.js',
    'nucleo/cobranca.js',
    'nucleo/contraste.js',
    'nucleo/vitais.js',
    'nucleo/minificar.js',
    'nucleo/sincronizador.js',
  ])('%s ainda carrega e exporta', async (caminho) => {
    const modulo = await import(new URL(`publico/${caminho}`, RAIZ).href);
    expect(Object.keys(modulo).length).toBeGreaterThan(0);
  });

  it('a reatividade continua funcionando minificada', async () => {
    const { observavel, efeito } = await import(
      new URL('publico/nucleo/reativo.js', RAIZ).href
    );

    const estado = observavel({ a: 1 });
    const visto = [];

    efeito(() => visto.push(estado.a));
    estado.a = 2;

    expect(visto).toEqual([1, 2]);
  });

  it('o minificador minificado ainda minifica', async () => {
    // Se ele quebrasse a si mesmo, o defeito passaria despercebido.
    const { minificarJS } = await import(
      new URL('publico/nucleo/minificar.js', RAIZ).href
    );

    expect(minificarJS('const  a  =  1 // nota')).toBe('const a=1');
  });

  it('os comentários saíram', async () => {
    const conteudo = await readFile(new URL('publico/nucleo/reativo.js', RAIZ), 'utf8');

    expect(conteudo).not.toContain('/**');
    expect(conteudo).not.toContain('Proxy é avisado');
  });

  it('o CSS perdeu espaço mas manteve os seletores', async () => {
    const conteudo = await readFile(new URL('publico/estilos/caixa.css', RAIZ), 'utf8');

    expect(conteudo).not.toContain('\n\n');
    expect(conteudo).toContain('.linha--confirmada');
  });

  it('o componente minificado ainda define o elemento', async () => {
    // Verificado por texto, e não por importação: `HTMLElement` não existe em
    // Node, e o que interessa aqui é a minificação não ter comido a definição.
    const conteudo = await readFile(
      new URL('publico/componentes/campo-valor.js', RAIZ),
      'utf8',
    );

    expect(conteudo).toContain('customElements.define');
    expect(conteudo).toContain('campo-valor');
    expect(conteudo).toContain('extends HTMLElement');
  });

  it('encolhe de verdade', async () => {
    const antes = await readFile(new URL('nucleo/reativo.js', RAIZ), 'utf8');
    const depois = await readFile(new URL('publico/nucleo/reativo.js', RAIZ), 'utf8');

    expect(depois.length).toBeLessThan(antes.length * 0.5);
  });
});
