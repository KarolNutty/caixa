/**
 * Web Vitals, medidos no navegador.
 *
 * Sem biblioteca. As três métricas que o Google usa para ranquear vêm de
 * `PerformanceObserver`, que é API do próprio navegador, e a `web-vitals` do
 * Google existe para resolver diferenças entre navegadores e casos de borda,
 * não para calcular algo que só ela sabe.
 *
 * O que a biblioteca faz e isto não: normaliza comportamento antigo do Safari,
 * lida com bfcache, e agrega INP por percentil. Para uma página de demonstração
 * o essencial basta, e o que importa é entender o que está sendo medido.
 */

/**
 * Os limites do Google, em milissegundos e sem unidade para o CLS.
 *
 * Não são arbitrários: LCP de 2,5s é onde a percepção passa de "carregou" para
 * "está demorando", e CLS de 0,1 é onde o deslocamento deixa de passar
 * despercebido e começa a fazer alguém clicar no lugar errado.
 */
export const LIMITES = {
  LCP: { bom: 2500, ruim: 4000, unidade: 'ms', nome: 'Maior conteúdo pintado' },
  CLS: { bom: 0.1, ruim: 0.25, unidade: '', nome: 'Deslocamento acumulado' },
  INP: { bom: 200, ruim: 500, unidade: 'ms', nome: 'Resposta à interação' },
  TTFB: { bom: 800, ruim: 1800, unidade: 'ms', nome: 'Primeiro byte' },
  FCP: { bom: 1800, ruim: 3000, unidade: 'ms', nome: 'Primeira pintura' },
};

export function classificar(metrica, valor) {
  const limite = LIMITES[metrica];
  if (!limite || valor === null || valor === undefined) return 'desconhecido';

  if (valor <= limite.bom) return 'bom';
  if (valor <= limite.ruim) return 'melhorar';
  return 'ruim';
}

/**
 * Observa uma entrada de performance sem quebrar onde ela não existe.
 *
 * Nem todo navegador implementa todos os tipos, e um `PerformanceObserver` com
 * tipo desconhecido lança. Falhar aqui derrubaria a página inteira por causa de
 * uma métrica.
 */
function observar(tipo, aoReceber, extras = {}) {
  if (typeof PerformanceObserver === 'undefined') return () => {};

  try {
    const observador = new PerformanceObserver((lista) => {
      for (const entrada of lista.getEntries()) aoReceber(entrada);
    });

    observador.observe({ type: tipo, buffered: true, ...extras });
    return () => observador.disconnect();
  } catch {
    return () => {};
  }
}

/**
 * O maior conteúdo pintado.
 *
 * O navegador emite várias vezes conforme descobre elementos maiores, e a
 * última vale. Por isso o valor só é definitivo quando a pessoa interage ou
 * sai da página: até lá, algo maior ainda pode aparecer.
 */
export function medirLCP(aoAtualizar) {
  let maior = null;

  return observar('largest-contentful-paint', (entrada) => {
    maior = entrada.startTime;
    aoAtualizar({ valor: maior, elemento: entrada.element?.tagName ?? null });
  });
}

/**
 * O deslocamento acumulado de layout.
 *
 * Duas sutilezas que quase todo mundo erra ao implementar à mão.
 *
 * **Deslocamento causado por interação não conta.** Abrir um acordeão empurra o
 * conteúdo, e isso é esperado: a pessoa pediu. Só o que acontece sozinho
 * incomoda, e o `hadRecentInput` marca a diferença.
 *
 * **O valor não é a soma de tudo.** É a maior *janela* de cinco segundos, com
 * até um segundo entre deslocamentos. Somar tudo puniria uma página aberta por
 * horas, onde cada rolagem acrescentaria um pouco.
 */
export function medirCLS(aoAtualizar) {
  let maiorJanela = 0;
  let janelaAtual = 0;
  let primeiroDaJanela = 0;
  let ultimoDaJanela = 0;

  return observar('layout-shift', (entrada) => {
    if (entrada.hadRecentInput) return;

    const abriuNovaJanela =
      janelaAtual !== 0 &&
      (entrada.startTime - ultimoDaJanela > 1000 ||
        entrada.startTime - primeiroDaJanela > 5000);

    if (abriuNovaJanela) {
      janelaAtual = 0;
      primeiroDaJanela = entrada.startTime;
    }

    if (janelaAtual === 0) primeiroDaJanela = entrada.startTime;

    janelaAtual += entrada.value;
    ultimoDaJanela = entrada.startTime;

    if (janelaAtual > maiorJanela) {
      maiorJanela = janelaAtual;
      aoAtualizar({ valor: maiorJanela });
    }
  });
}

/**
 * A resposta à interação.
 *
 * Mede o intervalo entre o toque e a próxima pintura, e não o tempo do
 * manipulador de evento. É a diferença entre "meu código rodou rápido" e "a
 * pessoa viu a resposta rápido", e só a segunda importa.
 *
 * O valor reportado é o pior, porque uma interação lenta entre vinte rápidas é
 * o que a pessoa lembra.
 */
export function medirINP(aoAtualizar) {
  let pior = 0;

  return observar(
    'event',
    (entrada) => {
      if (!entrada.interactionId) return;

      if (entrada.duration > pior) {
        pior = entrada.duration;
        aoAtualizar({ valor: pior, tipo: entrada.name });
      }
    },
    { durationThreshold: 16 },
  );
}

/** Tempo até o primeiro byte, que limita todo o resto. */
export function medirTTFB(aoAtualizar) {
  const [navegacao] = performance.getEntriesByType('navigation');
  if (navegacao) aoAtualizar({ valor: navegacao.responseStart });

  return () => {};
}

/** A primeira pintura com conteúdo. */
export function medirFCP(aoAtualizar) {
  return observar('paint', (entrada) => {
    if (entrada.name === 'first-contentful-paint') {
      aoAtualizar({ valor: entrada.startTime });
    }
  });
}

/**
 * Liga todas de uma vez.
 *
 * Devolve uma função que para tudo. Um observador vivo depois de a página
 * mudar continua acumulando, e o número reportado deixa de corresponder ao que
 * a pessoa viu.
 */
export function medirTudo(aoAtualizar) {
  const paradas = [
    medirLCP((dados) => aoAtualizar('LCP', dados)),
    medirCLS((dados) => aoAtualizar('CLS', dados)),
    medirINP((dados) => aoAtualizar('INP', dados)),
    medirTTFB((dados) => aoAtualizar('TTFB', dados)),
    medirFCP((dados) => aoAtualizar('FCP', dados)),
  ];

  return () => paradas.forEach((parar) => parar());
}

/** Formata o número do jeito que se lê cada métrica. */
export function formatar(metrica, valor) {
  if (valor === null || valor === undefined) return '—';

  if (metrica === 'CLS') return valor.toFixed(3);
  if (valor < 1000) return `${Math.round(valor)} ms`;

  return `${(valor / 1000).toFixed(2)} s`;
}
