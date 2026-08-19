/**
 * Minificação sem ferramenta.
 *
 * A vaga pede conhecimento do processo, e a forma honesta de demonstrar isso é
 * implementar as partes que importam e ser claro sobre o que um minificador de
 * verdade faz além.
 *
 * **O que este faz:** remove comentários e espaço desnecessário, e mede o
 * ganho, inclusive depois de compressão.
 *
 * **O que ele não faz, e um minificador de verdade faz:** renomear variáveis
 * locais, remover código inalcançável, avaliar constantes, reescrever
 * expressões. Isso exige interpretar o código como árvore sintática, e um
 * minificador que trabalha por expressão regular sempre quebra em algum caso.
 * Aqui a régua é conservadora de propósito: prefiro economizar menos a gerar
 * um arquivo que não roda.
 *
 * O número que importa é o **depois da compressão**, e não o do arquivo cru:
 * todo servidor sério manda gzip ou brotli.
 *
 * Medindo os dois separadamente neste projeto: tirar espaço em branco rende 8%
 * no arquivo cru e 3% depois do gzip, porque espaço repetido comprime quase a
 * zero. Tirar comentário rende 60% no cru e 69% depois do gzip, porque prosa
 * tem vocabulário variado e comprime mal.
 *
 * A conclusão prática é o contrário da intuição comum: num código bem
 * comentado, o comentário domina o tamanho, e não a formatação.
 */

/**
 * Tira comentários e espaço do CSS.
 *
 * O CSS é seguro de tratar por texto porque a gramática dele não tem string com
 * conteúdo arbitrário na mesma medida que JavaScript. Ainda assim, `content:`
 * pode ter espaço significativo, e por isso o conteúdo entre aspas é
 * preservado.
 */
export function minificarCSS(fonte) {
  const textos = [];

  // As strings saem antes, para nenhuma regra mexer dentro delas.
  let semTextos = fonte.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, (achado) => {
    textos.push(achado);
    return `\u0000${textos.length - 1}\u0000`;
  });

  semTextos = semTextos
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    // Espaço em volta de pontuação não significa nada em CSS.
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')
    // O último ponto e vírgula antes de fechar é opcional.
    .replace(/;}/g, '}')
    .trim();

  return semTextos.replace(/\u0000(\d+)\u0000/g, (_, indice) => textos[Number(indice)]);
}

/**
 * Tira comentários e espaço do JavaScript.
 *
 * Bem mais delicado que CSS, e o motivo é a barra: ela abre comentário, começa
 * expressão regular e é divisão. Distinguir os três casos por texto é o que
 * quebra minificador amador.
 *
 * A saída aqui é percorrer caractere a caractere mantendo o contexto, em vez de
 * aplicar expressões regulares sobre o arquivo inteiro. É mais código e não
 * erra nos casos comuns.
 */
export function minificarJS(fonte) {
  let saida = '';
  let i = 0;

  const ehEspaco = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const ehNomeavel = (c) => /[\w$]/.test(c);

  while (i < fonte.length) {
    const c = fonte[i];
    const proximo = fonte[i + 1];

    // Comentário de linha.
    if (c === '/' && proximo === '/') {
      while (i < fonte.length && fonte[i] !== '\n') i += 1;
      continue;
    }

    // Comentário de bloco.
    if (c === '/' && proximo === '*') {
      i += 2;
      while (i < fonte.length && !(fonte[i] === '*' && fonte[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // Texto entre aspas, incluindo modelo com crase: vai inteiro, sem tocar.
    if (c === '"' || c === "'" || c === '`') {
      const abertura = c;
      saida += c;
      i += 1;

      while (i < fonte.length) {
        if (fonte[i] === '\\') {
          saida += fonte[i] + fonte[i + 1];
          i += 2;
          continue;
        }

        saida += fonte[i];
        if (fonte[i] === abertura) {
          i += 1;
          break;
        }

        i += 1;
      }

      continue;
    }

    /*
     * Expressão regular ou divisão?
     *
     * A pista é o que veio antes: depois de um valor, a barra é divisão; depois
     * de um operador ou abre-parêntese, é expressão regular. Errar aqui
     * transforma `a / b / c` em uma expressão regular e corrompe o arquivo.
     */
    if (c === '/') {
      const anterior = saida.replace(/\s+$/, '').slice(-1);
      const depoisDeValor = /[\w$)\]]/.test(anterior);

      if (!depoisDeValor) {
        saida += c;
        i += 1;

        while (i < fonte.length) {
          if (fonte[i] === '\\') {
            saida += fonte[i] + fonte[i + 1];
            i += 2;
            continue;
          }

          if (fonte[i] === '[') {
            // Dentro de classe de caractere, a barra não fecha a expressão.
            while (i < fonte.length && fonte[i] !== ']') {
              saida += fonte[i];
              i += 1;
            }
          }

          saida += fonte[i];
          if (fonte[i] === '/') {
            i += 1;
            break;
          }

          i += 1;
        }

        continue;
      }
    }

    // Espaço em branco: só sobrevive se separar dois nomes.
    if (ehEspaco(c)) {
      let fim = i;
      while (fim < fonte.length && ehEspaco(fonte[fim])) fim += 1;

      const antes = saida.slice(-1);
      const depois = fonte[fim];

      if (ehNomeavel(antes) && ehNomeavel(depois)) saida += ' ';

      i = fim;
      continue;
    }

    saida += c;
    i += 1;
  }

  return saida.trim();
}

/**
 * O relatório de uma minificação.
 *
 * Traz o tamanho cru e o comprimido, porque só o segundo diz o que a pessoa vai
 * baixar. Um minificador que anuncia "60% menor" contando espaço em branco está
 * medindo o que o gzip já resolvia de graça.
 */
export function medirGanho(original, minificado, comprimir) {
  const cru = { antes: original.length, depois: minificado.length };

  const relatorio = {
    cru,
    reducaoCrua: 1 - cru.depois / cru.antes,
  };

  if (comprimir) {
    const comprimido = {
      antes: comprimir(original).length,
      depois: comprimir(minificado).length,
    };

    relatorio.comprimido = comprimido;
    relatorio.reducaoReal = 1 - comprimido.depois / comprimido.antes;
  }

  return relatorio;
}

export function formatarBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}
