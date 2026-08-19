import '../componentes/campo-valor.js';
import { avaliar, lerToken, razaoDeContraste } from '../nucleo/contraste.js';
import { LIMITES, classificar, formatar, medirTudo } from '../nucleo/vitais.js';

/**
 * A documentação do sistema.
 *
 * Ela **lê o CSS aplicado** em vez de repetir valores escritos à mão. Uma
 * tabela de cores digitada envelhece no primeiro ajuste de token e passa a
 * mentir em silêncio, e documentação que mente é pior que documentação
 * nenhuma: alguém confia nela e toma uma decisão errada.
 *
 * Aqui, mudar um token muda a página. E o contraste é calculado, não afirmado.
 */

/**
 * As combinações que precisam ser verificadas.
 *
 * Não é toda cor contra toda cor: o que importa é onde texto realmente aparece
 * sobre fundo. Uma matriz completa geraria centenas de pares que ninguém usa, e
 * os reprovados irrelevantes escondem os que importam.
 */
const COMBINACOES = [
  { texto: '--tinta', fundo: '--superficie', uso: 'Texto principal' },
  { texto: '--tinta-media', fundo: '--superficie', uso: 'Texto de apoio' },
  { texto: '--tinta-fraca', fundo: '--superficie', uso: 'Rótulos e legendas' },
  { texto: '--tinta', fundo: '--fundo', uso: 'Texto sobre a página' },
  { texto: '--tinta-fraca', fundo: '--campo', uso: 'Placeholder em campo' },
  { texto: '--acento', fundo: '--superficie', uso: 'Link e destaque' },
  { texto: '--acento', fundo: '--acento-claro', uso: 'Etiqueta de envio' },
  { texto: '--sucesso', fundo: '--sucesso-claro', uso: 'Etiqueta confirmada' },
  { texto: '--atencao', fundo: '--atencao-claro', uso: 'Etiqueta na fila' },
  { texto: '--erro', fundo: '--erro-claro', uso: 'Etiqueta recusada' },
  { texto: '--erro', fundo: '--superficie', uso: 'Mensagem de erro' },
];

const GRUPOS_DE_COR = [
  {
    titulo: 'Superfícies',
    nota: 'Do fundo da página ao campo de entrada. A diferença entre elas é o que cria profundidade sem sombra.',
    tokens: ['--fundo', '--superficie', '--campo', '--borda'],
  },
  {
    titulo: 'Texto',
    nota: 'Três pesos, e não cinco. Cada nível a mais é uma decisão que alguém vai tomar errado.',
    tokens: ['--tinta', '--tinta-media', '--tinta-fraca'],
  },
  {
    titulo: 'Ação',
    nota: 'Uma cor só para o que a pessoa pode fazer. Duas cores de ação obrigam a explicar a diferença.',
    tokens: ['--acento', '--acento-forte', '--acento-claro'],
  },
  {
    titulo: 'Estado',
    nota: 'Cada uma existe porque um estado precisa ser lido de relance, e nenhuma é decorativa.',
    tokens: [
      '--sucesso',
      '--sucesso-claro',
      '--atencao',
      '--atencao-claro',
      '--erro',
      '--erro-claro',
    ],
  },
];

function desenharCores() {
  const alvo = document.querySelector('#cores');

  alvo.innerHTML = GRUPOS_DE_COR.map(
    (grupo) => `
      <section class="grupo">
        <h3 class="grupo__titulo">${grupo.titulo}</h3>
        <p class="grupo__nota">${grupo.nota}</p>

        <div class="amostras">
          ${grupo.tokens
            .map((token) => {
              const valor = lerToken(token);

              return `
                <div class="amostra">
                  <div class="amostra__cor" style="background: var(${token})"></div>
                  <code class="amostra__token">${token}</code>
                  <span class="amostra__valor">${valor}</span>
                </div>
              `;
            })
            .join('')}
        </div>
      </section>
    `,
  ).join('');
}

function desenharContraste() {
  const alvo = document.querySelector('#contraste');

  const linhas = COMBINACOES.map((combinacao) => {
    const frente = lerToken(combinacao.texto);
    const fundo = lerToken(combinacao.fundo);
    const razao = razaoDeContraste(frente, fundo);
    const veredito = avaliar(razao ?? 0);

    return { ...combinacao, frente, fundo, razao, veredito };
  });

  const reprovados = linhas.filter((linha) => !linha.veredito.passa);

  alvo.innerHTML = `
    ${
      reprovados.length > 0
        ? `<p class="alerta" role="alert">
             ${reprovados.length} ${reprovados.length === 1 ? 'combinação está' : 'combinações estão'}
             abaixo do mínimo de 4,5. Elas aparecem marcadas abaixo.
           </p>`
        : `<p class="tudo-certo">
             As ${linhas.length} combinações em uso passam no mínimo de 4,5 da WCAG.
           </p>`
    }

    <table class="tabela">
      <caption class="sr-apenas">
        Contraste de cada combinação de texto e fundo usada no sistema
      </caption>

      <thead>
        <tr>
          <th scope="col">Onde aparece</th>
          <th scope="col">Exemplo</th>
          <th scope="col">Razão</th>
          <th scope="col">Nível</th>
        </tr>
      </thead>

      <tbody>
        ${linhas
          .map(
            (linha) => `
              <tr>
                <td>
                  <span class="uso">${linha.uso}</span>
                  <code class="par">${linha.texto} sobre ${linha.fundo}</code>
                </td>

                <td>
                  <span
                    class="exemplo"
                    style="color: var(${linha.texto}); background: var(${linha.fundo})"
                  >Texto de exemplo</span>
                </td>

                <td class="numero">${linha.razao ? linha.razao.toFixed(2) : '—'}</td>

                <td>
                  <span class="nivel nivel--${linha.veredito.nivel}">
                    ${linha.veredito.nivel}
                  </span>
                </td>
              </tr>
            `,
          )
          .join('')}
      </tbody>
    </table>
  `;
}

/**
 * O contraste é recalculado quando o tema muda.
 *
 * Sem isto, a página mostraria os números do tema claro enquanto exibe o
 * escuro, e um sistema com dois temas tem duas paletas para verificar, não uma.
 */
function acompanharTema() {
  const consulta = matchMedia('(prefers-color-scheme: dark)');

  const recalcular = () => {
    // O quadro seguinte, para o navegador já ter aplicado os novos valores:
    // ler antes devolveria a paleta anterior.
    requestAnimationFrame(() => {
      desenharCores();
      desenharContraste();
    });
  };

  consulta.addEventListener('change', recalcular);

  document.querySelector('#tema')?.addEventListener('change', (evento) => {
    const escolha = evento.target.value;

    if (escolha === 'sistema') delete document.documentElement.dataset.tema;
    else document.documentElement.dataset.tema = escolha;

    recalcular();
  });
}

/** Os exemplos vivos: componentes de verdade, não imagem. */
function ligarExemplos() {
  const campo = document.querySelector('#exemplo-valor');
  const saida = document.querySelector('#exemplo-valor-saida');

  campo?.addEventListener('valor', (evento) => {
    saida.textContent = `${evento.detail.centavos} centavos`;
  });

  document.querySelector('#exemplo-erro')?.addEventListener('click', () => {
    const alvo = document.querySelector('#exemplo-campo-erro');
    const invalido = alvo.getAttribute('aria-invalid') === 'true';

    alvo.setAttribute('aria-invalid', invalido ? 'false' : 'true');
    document.querySelector('#exemplo-mensagem').textContent = invalido
      ? ''
      : 'Informe um e-mail válido.';
  });
}

desenharCores();
desenharContraste();
acompanharTema();
ligarExemplos();

/** --------------------------------------------------------- Web Vitals */

/**
 * As métricas desta página, medidas ao vivo.
 *
 * Mostrar o número da própria documentação, e não de uma medição feita uma vez
 * e colada num README, é a diferença entre afirmar que a página é rápida e
 * provar.
 *
 * O LCP e o INP levam alguns segundos para estabilizar: o LCP só é definitivo
 * quando a pessoa interage, e o INP precisa de uma interação para existir. A
 * tabela avisa isso em vez de mostrar zero, porque zero pareceria perfeito.
 */
const medidas = {};

function desenharVitais() {
  const alvo = document.querySelector('#vitais');
  if (!alvo) return;

  alvo.innerHTML = `
    <table class="tabela">
      <caption class="sr-apenas">Métricas de performance desta página</caption>

      <thead>
        <tr>
          <th scope="col">Métrica</th>
          <th scope="col">O que mede</th>
          <th scope="col">Valor</th>
          <th scope="col">Limite</th>
        </tr>
      </thead>

      <tbody>
        ${Object.entries(LIMITES)
          .map(([sigla, limite]) => {
            const valor = medidas[sigla]?.valor;
            const nivel = classificar(sigla, valor);

            return `
              <tr>
                <td><strong>${sigla}</strong></td>
                <td class="uso">${limite.nome}</td>
                <td class="numero">
                  ${
                    valor === undefined
                      ? '<span class="aguardando">aguardando</span>'
                      : formatar(sigla, valor)
                  }
                </td>
                <td>
                  <span class="nivel nivel--${nivel}">
                    ${
                      nivel === 'desconhecido'
                        ? `bom até ${formatar(sigla, limite.bom)}`
                        : nivel
                    }
                  </span>
                </td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>

    <p class="nota-vitais">
      O INP só aparece depois de uma interação, e o LCP se estabiliza quando
      você toca em algo ou sai da página. Clique em qualquer lugar para o INP
      começar a medir.
    </p>
  `;
}

medirTudo((sigla, dados) => {
  medidas[sigla] = dados;
  desenharVitais();
});

desenharVitais();
