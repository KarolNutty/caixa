/**
 * Reatividade.
 *
 * O problema que isto resolve: quando o estado muda, a tela precisa acompanhar.
 * Sem framework, as duas saídas óbvias são ruins.
 *
 * Redesenhar tudo a cada mudança perde foco, seleção e posição de rolagem, e
 * fica lento quando a lista cresce. Chamar `atualizarTela()` na mão depois de
 * cada alteração funciona até alguém esquecer, e o defeito aparece longe da
 * causa.
 *
 * A saída daqui é rastrear a leitura. Quando um efeito roda, o Proxy anota
 * quais campos ele leu; quando um campo muda, só os efeitos que leram aquele
 * campo rodam de novo. Ninguém declara dependência, e por isso ninguém esquece
 * de atualizar a declaração.
 */

/**
 * O efeito em execução.
 *
 * Precisa ser global porque o Proxy é avisado da leitura lá dentro do getter,
 * sem saber quem está lendo. É a mesma solução que Vue e Solid usam, e o motivo
 * é o mesmo: não existe como passar esse contexto pela pilha de chamadas.
 */
let efeitoAtual = null;

/** Efeitos que dependem de cada campo, por objeto observado. */
const dependencias = new WeakMap();

/**
 * Enquanto um lote está aberto, os efeitos são acumulados em vez de executados.
 *
 * Sem isto, mudar três campos do estado dispara o mesmo efeito três vezes, e a
 * tela pisca no meio de uma operação que a pessoa vê como única.
 */
let lote = null;

function anotarLeitura(alvo, campo) {
  if (!efeitoAtual) return;

  let porCampo = dependencias.get(alvo);
  if (!porCampo) {
    porCampo = new Map();
    dependencias.set(alvo, porCampo);
  }

  let efeitos = porCampo.get(campo);
  if (!efeitos) {
    efeitos = new Set();
    porCampo.set(campo, efeitos);
  }

  efeitos.add(efeitoAtual);

  // O efeito guarda onde está inscrito, para poder se desinscrever. Sem isso,
  // um efeito que deixa de ler um campo continua rodando quando ele muda.
  efeitoAtual.inscricoes.push(efeitos);
}

function avisarMudanca(alvo, campo) {
  const porCampo = dependencias.get(alvo);
  if (!porCampo) return;

  const efeitos = porCampo.get(campo);
  if (!efeitos) return;

  // A cópia é necessária: um efeito pode se reinscrever enquanto roda, e
  // percorrer o conjunto original durante a alteração pula elementos.
  for (const efeito of [...efeitos]) {
    if (lote) lote.add(efeito);
    else efeito.executar();
  }
}

/**
 * Torna um objeto observável.
 *
 * O Proxy é raso por escolha: aninhar transformaria cada leitura numa criação
 * de proxy, e o custo aparece em lista grande. O estado desta aplicação é
 * plano de propósito, e onde precisa de estrutura ela é substituída inteira,
 * não editada por dentro.
 */
export function observavel(inicial) {
  return new Proxy(inicial, {
    get(alvo, campo, receptor) {
      anotarLeitura(alvo, campo);
      return Reflect.get(alvo, campo, receptor);
    },

    set(alvo, campo, valor, receptor) {
      const anterior = alvo[campo];

      // `Object.is` em vez de `!==`, para `NaN` não disparar mudança contra si
      // mesmo e `-0` não ser confundido com `0`.
      if (Object.is(anterior, valor)) return true;

      const resultado = Reflect.set(alvo, campo, valor, receptor);
      avisarMudanca(alvo, campo);
      return resultado;
    },

    deleteProperty(alvo, campo) {
      const existia = campo in alvo;
      const resultado = Reflect.deleteProperty(alvo, campo);

      if (existia) avisarMudanca(alvo, campo);
      return resultado;
    },
  });
}

/**
 * Roda a função agora e de novo sempre que algo que ela leu mudar.
 *
 * Devolve uma função que cancela a inscrição. Um efeito que continua vivo
 * depois de a tela sumir segura o estado inteiro na memória e escreve num DOM
 * que não existe mais.
 */
export function efeito(fn) {
  const registro = {
    inscricoes: [],

    executar() {
      // Desinscrever antes de rodar é o que permite dependência condicional:
      // um efeito que lê `b` só quando `a` é verdadeiro deixa de acompanhar `b`
      // assim que `a` vira falso.
      registro.limpar();

      const anterior = efeitoAtual;
      efeitoAtual = registro;

      try {
        fn();
      } finally {
        // No `finally` porque uma exceção dentro do efeito não pode deixar o
        // rastreador apontando para ele: o próximo efeito herdaria as leituras.
        efeitoAtual = anterior;
      }
    },

    limpar() {
      for (const efeitos of registro.inscricoes) efeitos.delete(registro);
      registro.inscricoes = [];
    },
  };

  registro.executar();

  return () => registro.limpar();
}

/**
 * Agrupa mudanças numa atualização só.
 *
 * Mudar três campos dispara o mesmo efeito três vezes sem isto, e a tela pisca
 * no meio de uma operação que a pessoa enxerga como única.
 */
export function emLote(fn) {
  // Lote aninhado não abre um novo: só o mais externo executa, senão a parte
  // interna dispararia antes de a externa terminar.
  if (lote) {
    fn();
    return;
  }

  lote = new Set();

  try {
    fn();
  } finally {
    const pendentes = lote;
    lote = null;

    for (const efeito of pendentes) efeito.executar();
  }
}

/**
 * Roda a função sem anotar as leituras.
 *
 * Existe porque escrever dentro de um efeito costuma exigir ler antes, e um
 * efeito que lê o que ele mesmo escreve vira recursão infinita. Foi exatamente
 * o que aconteceu na primeira versão do `derivado` abaixo.
 */
export function semRastrear(fn) {
  const anterior = efeitoAtual;
  efeitoAtual = null;

  try {
    return fn();
  } finally {
    efeitoAtual = anterior;
  }
}

/**
 * Um valor calculado a partir de outros.
 *
 * O cálculo roda dentro de um efeito, então ele acompanha sozinho tudo o que
 * leu. Quando algo muda, recalcula uma vez e avisa quem depende dele.
 *
 * O aviso usa `semRastrear`. Sem isso, incrementar a versão conta como leitura
 * da versão, o efeito passa a depender do próprio sinal, e cada execução
 * dispara a seguinte até a pilha estourar.
 *
 * É recalculado sempre que a origem muda, mesmo se ninguém estiver lendo. A
 * alternativa preguiçosa exigiria rodar o cálculo duas vezes por mudança, uma
 * para descobrir as dependências e outra para produzir o valor, e aqui os
 * cálculos são somas de carrinho, não trabalho pesado.
 */
export function derivado(calcular) {
  let valor;
  const sinal = observavel({ versao: 0 });

  efeito(() => {
    valor = calcular();
    semRastrear(() => {
      sinal.versao += 1;
    });
  });

  return {
    get valor() {
      // A leitura da versão é o que inscreve quem lê este derivado: sem ela, um
      // efeito que só usa o total não seria avisado quando a origem mudasse.
      void sinal.versao;
      return valor;
    },
  };
}
