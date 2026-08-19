import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * O servidor de demonstração.
 *
 * Parece detalhe de conveniência e tem duas armadilhas reais: servir uma pasta
 * sem barra no fim, e servir mais do que devia.
 */

const PORTA = 4399;
const BASE = `http://localhost:${PORTA}`;

let processo;

beforeAll(async () => {
  processo = spawn('node', ['servidor.js'], {
    env: { ...process.env, PORTA: String(PORTA) },
    stdio: 'ignore',
  });

  // Espera o servidor responder, em vez de dormir um tempo fixo: tempo fixo é
  // curto demais numa máquina lenta e desperdiçado numa rápida.
  for (let tentativa = 0; tentativa < 50; tentativa += 1) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  throw new Error('o servidor não subiu');
});

afterAll(() => {
  processo?.kill();
});

describe('o que o servidor entrega', () => {
  it.each([
    ['/', 'a aplicação'],
    ['/app.js', 'o módulo principal'],
    ['/nucleo/reativo.js', 'o núcleo'],
    ['/estilos/caixa.css', 'os estilos'],
    ['/docs/', 'a documentação'],
  ])('serve %s (%s)', async (caminho) => {
    const resposta = await fetch(BASE + caminho);
    expect(resposta.status).toBe(200);
  });

  it('pasta sem barra no fim redireciona, e não serve direto', async () => {
    /**
     * Servir `/docs` diretamente parece funcionar e quebra o CSS.
     *
     * O navegador resolve `href="sistema.css"` relativo a `/docs`, tratando
     * `docs` como arquivo, e vai procurar `/sistema.css`. Já
     * `../estilos/caixa.css` resolve igual nos dois casos, então metade do
     * estilo carrega e o defeito parece problema de layout.
     *
     * A URL define como os caminhos relativos são resolvidos, e é por isso que
     * todo servidor sério manda 301 para a barra.
     */
    const resposta = await fetch(`${BASE}/docs`, { redirect: 'manual' });

    expect(resposta.status).toBe(301);
    expect(resposta.headers.get('location')).toBe('/docs/');
  });

  it('seguindo o redirecionamento, o CSS da documentação resolve', async () => {
    const resposta = await fetch(`${BASE}/docs`);

    expect(resposta.url).toMatch(/\/docs\/$/);

    // O caminho relativo é resolvido a partir da URL final, como o navegador faz.
    const css = await fetch(new URL('sistema.css', resposta.url));
    expect(css.status).toBe(200);
  });

  it('a raiz não é redirecionada', async () => {
    // `/` já é uma pasta com barra: redirecionar criaria um laço.
    const resposta = await fetch(BASE, { redirect: 'manual' });
    expect(resposta.status).toBe(200);
  });
});

describe('o que o servidor esconde', () => {
  /**
   * A lista é de permissão, e não de bloqueio: bloquear o que se lembra deixa
   * passar o que se esquece, e o esquecido é sempre o que importa.
   */
  it.each([
    ['/package.json', 'metadados do projeto'],
    ['/servidor.js', 'o próprio servidor'],
    ['/.git/config', 'o repositório'],
    ['/testes/fila.test.js', 'os testes'],
    ['/node_modules/vitest/package.json', 'as dependências'],
  ])('não serve %s (%s)', async (caminho) => {
    const resposta = await fetch(BASE + caminho);
    expect(resposta.status).not.toBe(200);
  });

  it('caminho com .. não escapa da pasta', async () => {
    const resposta = await fetch(`${BASE}/../package.json`);
    expect(resposta.status).not.toBe(200);
  });
});

describe('idempotência', () => {
  const corpo = JSON.stringify({
    valor: 4990,
    descricao: 'Plano',
    cliente: 'ana@exemplo.com',
  });

  function cabecalhos(chave) {
    return { 'content-type': 'application/json', 'idempotency-key': chave };
  }

  it('a mesma chave devolve a mesma cobrança', async () => {
    /**
     * O comportamento que a fila depende. Sem ele, uma resposta perdida depois
     * do processamento viraria segunda cobrança, e o cliente pagaria duas vezes
     * por um problema de rede.
     *
     * O servidor falha de propósito em parte das chamadas, então a primeira
     * criação pode exigir algumas tentativas.
     */
    const chave = `teste-${Date.now()}`;
    let primeira = null;

    for (let tentativa = 0; tentativa < 30 && !primeira; tentativa += 1) {
      const resposta = await fetch(`${BASE}/api/cobrancas`, {
        method: 'POST',
        headers: cabecalhos(chave),
        body: corpo,
      });

      if (resposta.status === 201) primeira = await resposta.json();
      // Uma recusa definitiva usa a mesma chave, e aí o teste precisa de outra.
      else if (resposta.status === 402) return;
    }

    expect(primeira).toBeTruthy();

    const repetida = await fetch(`${BASE}/api/cobrancas`, {
      method: 'POST',
      headers: cabecalhos(chave),
      body: corpo,
    });

    const segunda = await repetida.json();

    expect(segunda.id).toBe(primeira.id);
    expect(segunda.repetida).toBe(true);
  });

  it('sem a chave, recusa', async () => {
    // Aceitar sem chave permitiria uma cobrança que ninguém consegue repetir
    // com segurança.
    const resposta = await fetch(`${BASE}/api/cobrancas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: corpo,
    });

    expect(resposta.status).toBe(400);
  });

  it('valor inválido é recusado em definitivo', async () => {
    const resposta = await fetch(`${BASE}/api/cobrancas`, {
      method: 'POST',
      headers: cabecalhos(`invalido-${Date.now()}`),
      body: JSON.stringify({ valor: 5, descricao: 'x', cliente: 'a@b.co' }),
    });

    expect(resposta.status).toBe(422);
  });
});

describe('caminhos entre sistemas', () => {
  /**
   * O bug que derrubou o servidor inteiro no Windows.
   *
   * `path.normalize` converte as barras para o separador do sistema, então
   * `/index.html` vira `\\index.html` no Windows. A checagem de permissão
   * dividia por barra normal, não achava nada, e **tudo devolvia 404**.
   *
   * Caminho de URL e caminho de arquivo são coisas diferentes: URL sempre usa
   * barra normal, em qualquer sistema. Misturar os dois é erro que passa
   * despercebido em quem desenvolve sempre no mesmo sistema.
   */

  it('a resolução usa barra normal, e não o separador do sistema', async () => {
    const { posix, win32 } = await import('node:path');

    // No Windows, `normalize` do módulo comum produziria isto:
    expect(win32.normalize('/docs/index.html')).toBe('\\docs\\index.html');

    // E é por isso que a resolução usa `posix`, que é estável entre sistemas.
    expect(posix.normalize('/docs/index.html')).toBe('/docs/index.html');
  });

  it('dividir o caminho por barra encontra a pasta em qualquer sistema', async () => {
    const { posix } = await import('node:path');

    const relativo = posix.normalize('/nucleo/reativo.js');
    expect(relativo.split('/')[1]).toBe('nucleo');
  });
});
