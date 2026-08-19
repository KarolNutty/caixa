/**
 * Campo de valor em reais.
 *
 * Guarda **centavos, em inteiro**. Nunca ponto flutuante: `0.1 + 0.2` dá
 * `0.30000000000000004`, e num sistema de cobrança essa diferença vira
 * divergência de centavo no fechamento do dia. Dinheiro é contagem, não medida.
 *
 * A máscara é o detalhe que separa um campo que funciona de um que irrita. O
 * jeito ingênuo, `campo.value = formatar(campo.value)`, joga o cursor para o
 * fim a cada tecla. Quem edita no meio de um valor já digitado perde o lugar e
 * precisa reposicionar depois de cada caractere.
 *
 * A saída: contar quantos **dígitos** existem antes do cursor, reformatar, e
 * recolocar o cursor depois do mesmo número de dígitos. Separadores mudam de
 * lugar; a posição relativa aos dígitos, não.
 */

/** Só os dígitos, que é o que o valor realmente é. */
export function somenteDigitos(texto) {
  return texto.replace(/\D/g, '');
}

/**
 * Converte o que foi digitado em centavos.
 *
 * O limite existe porque um valor colado de uma planilha pode ter vinte
 * dígitos, e `Number` perde precisão acima de 2^53. Cortar é melhor que
 * guardar um número errado em silêncio.
 */
export function paraCentavos(texto, maximoDeDigitos = 12) {
  const digitos = somenteDigitos(texto).slice(0, maximoDeDigitos);
  return digitos === '' ? 0 : Number(digitos);
}

/** Centavos em reais, no formato do país. */
export function formatarBRL(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/**
 * Onde o cursor deve ficar depois de reformatar.
 *
 * Conta os dígitos à esquerda do cursor no texto antigo, e procura a posição
 * no texto novo que tem esse mesmo número de dígitos à esquerda. É por isso
 * que apagar um separador não trava o cursor: o separador não conta.
 */
export function posicaoDoCursor(textoNovo, digitosAntes) {
  if (digitosAntes <= 0) return textoNovo.length;

  let contados = 0;

  for (let i = 0; i < textoNovo.length; i += 1) {
    if (/\d/.test(textoNovo[i])) {
      contados += 1;
      if (contados === digitosAntes) return i + 1;
    }
  }

  return textoNovo.length;
}

/** Quantos dígitos existem antes de uma posição. */
export function digitosAntesDe(texto, posicao) {
  return somenteDigitos(texto.slice(0, posicao)).length;
}

export class CampoValor extends HTMLElement {
  static observedAttributes = ['valor', 'rotulo', 'erro'];

  #campo = null;
  #centavos = 0;

  constructor() {
    super();
    // Shadow DOM: o estilo daqui não vaza e o de fora não entra. Num
    // componente de pagamento isso importa mais que o normal, porque uma regra
    // global mal escrita não pode esconder o valor que a pessoa vai pagar.
    this.attachShadow({ mode: 'open' });
  }

  get valor() {
    return this.#centavos;
  }

  set valor(centavos) {
    this.#centavos = Math.max(0, Math.round(Number(centavos) || 0));
    if (this.#campo) this.#campo.value = formatarBRL(this.#centavos);
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        label {
          display: block;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--tinta-fraca, #6b7280);
          margin-bottom: 6px;
        }

        input {
          width: 100%;
          box-sizing: border-box;
          font: inherit;
          font-size: 22px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          padding: 14px 16px;
          border: 2px solid var(--borda, #e5e7eb);
          border-radius: 14px;
          background: var(--campo, #f9fafb);
          color: var(--tinta, #111827);
        }

        input:focus-visible {
          outline: none;
          border-color: var(--acento, #4f46e5);
        }

        :host([erro]) input { border-color: var(--erro, #dc2626); }

        p {
          margin: 6px 0 0;
          font-size: 13px;
          font-weight: 700;
          color: var(--erro, #dc2626);
        }
      </style>

      <label part="rotulo" for="campo">${this.getAttribute('rotulo') ?? 'Valor'}</label>

      <input
        id="campo"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        aria-describedby="erro"
      />

      <p id="erro" role="alert"></p>
    `;

    this.#campo = this.shadowRoot.querySelector('input');
    this.valor = this.getAttribute('valor') ?? 0;

    this.#campo.addEventListener('input', this.#aoDigitar);
    this.#campo.addEventListener('focus', () => this.#campo.select());
  }

  disconnectedCallback() {
    this.#campo?.removeEventListener('input', this.#aoDigitar);
  }

  attributeChangedCallback(nome, _antes, agora) {
    if (!this.#campo) return;

    if (nome === 'valor') this.valor = agora;
    if (nome === 'rotulo') this.shadowRoot.querySelector('label').textContent = agora;
    if (nome === 'erro') {
      this.shadowRoot.querySelector('#erro').textContent = agora ?? '';
    }
  }

  #aoDigitar = () => {
    const campo = this.#campo;
    const textoAntigo = campo.value;
    const cursorAntigo = campo.selectionStart ?? textoAntigo.length;

    const digitosAntes = digitosAntesDe(textoAntigo, cursorAntigo);

    this.#centavos = paraCentavos(textoAntigo);
    const textoNovo = formatarBRL(this.#centavos);

    campo.value = textoNovo;

    // A recolocação precisa acontecer depois de o valor mudar, senão o
    // navegador move o cursor para o fim por conta própria.
    const posicao = posicaoDoCursor(textoNovo, digitosAntes);
    campo.setSelectionRange(posicao, posicao);

    this.dispatchEvent(
      new CustomEvent('valor', {
        detail: { centavos: this.#centavos },
        bubbles: true,
        composed: true,
      }),
    );
  };
}

if (globalThis.customElements && !customElements.get('campo-valor')) {
  customElements.define('campo-valor', CampoValor);
}
