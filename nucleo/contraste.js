/**
 * Contraste, medido.
 *
 * A parte da documentação que a maioria dos sistemas de design não tem: em vez
 * de afirmar que a paleta é acessível, a página calcula a razão de cada
 * combinação e mostra o número.
 *
 * Isso muda o que a documentação é. Uma tabela de cores escrita à mão envelhece
 * no primeiro ajuste de token e passa a mentir em silêncio. Uma que calcula a
 * partir do valor atual não tem como divergir do produto.
 *
 * A fórmula é a da WCAG 2.1, e o mínimo para texto normal é 4,5.
 */

/** Converte qualquer cor que o navegador entenda para os três canais. */
export function paraRGB(cor) {
  const texto = String(cor).trim();

  const hexa = texto.match(/^#?([\da-f]{3}|[\da-f]{6})$/i);
  if (hexa) {
    const bruto = hexa[1];
    const cheio =
      bruto.length === 3
        ? bruto
            .split('')
            .map((c) => c + c)
            .join('')
        : bruto;

    return [
      Number.parseInt(cheio.slice(0, 2), 16),
      Number.parseInt(cheio.slice(2, 4), 16),
      Number.parseInt(cheio.slice(4, 6), 16),
    ];
  }

  const funcional = texto.match(/rgba?\(([^)]+)\)/i);
  if (funcional) {
    const partes = funcional[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [partes[0] ?? 0, partes[1] ?? 0, partes[2] ?? 0];
  }

  return null;
}

/**
 * Luminância relativa.
 *
 * A curva não é linear porque o olho não é: a diferença entre 10% e 20% de luz
 * é percebida como maior que entre 80% e 90%. É por isso que a média simples
 * dos canais não serve.
 */
export function luminancia(rgb) {
  const [r, g, b] = rgb.map((canal) => {
    const normal = canal / 255;
    return normal <= 0.03928 ? normal / 12.92 : ((normal + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A razão entre duas cores, de 1 a 21. */
export function razaoDeContraste(frente, fundo) {
  const a = paraRGB(frente);
  const b = paraRGB(fundo);

  if (!a || !b) return null;

  const la = luminancia(a);
  const lb = luminancia(b);

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Mistura uma cor translúcida sobre um fundo.
 *
 * Necessário porque texto com opacidade não tem o contraste da cor declarada,
 * e sim o da mistura. Ignorar isso é o erro mais comum ao verificar paleta: a
 * cor "passa", o texto real não.
 */
export function misturar(frente, alfa, fundo) {
  const f = paraRGB(frente);
  const t = paraRGB(fundo);

  if (!f || !t) return null;

  return f.map((canal, i) => Math.round(canal * alfa + t[i] * (1 - alfa)));
}

/**
 * O veredito, com os três níveis que a WCAG define.
 *
 * Texto grande tem exigência menor porque traço grosso é mais fácil de
 * distinguir, e é por isso que um título pode usar cor que um parágrafo não
 * pode.
 */
export function avaliar(razao, { grande = false } = {}) {
  if (razao === null) return { nivel: 'desconhecido', passa: false };

  const minimoAA = grande ? 3 : 4.5;
  const minimoAAA = grande ? 4.5 : 7;

  if (razao >= minimoAAA) return { nivel: 'AAA', passa: true };
  if (razao >= minimoAA) return { nivel: 'AA', passa: true };

  return { nivel: 'reprovado', passa: false };
}

/**
 * Lê o valor real de um token no documento.
 *
 * É isso que impede a documentação de divergir do produto: o número vem do CSS
 * aplicado, não de uma lista escrita à mão que ninguém atualiza.
 */
export function lerToken(nome, elemento = document.documentElement) {
  return getComputedStyle(elemento).getPropertyValue(nome).trim();
}
