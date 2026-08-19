import './componentes/campo-valor.js';
import { formatarBRL } from './componentes/campo-valor.js';
import {
  ROTULO_DO_ESTADO,
  novaChave,
  problemasDaCobranca,
  resumir,
} from './nucleo/cobranca.js';
import { ESTADOS, abrirBanco, enfileirar, listar, remover } from './nucleo/fila.js';
import { derivado, efeito, emLote, observavel } from './nucleo/reativo.js';
import {
  criarCanal,
  criarEleicao,
  iniciarSincronizacao,
} from './nucleo/sincronizador.js';

/**
 * O caixa.
 *
 * Junta as quatro peças: o estado observável, a fila durável, o sincronizador e
 * os componentes. Nenhum framework, e a estrutura é a mesma que um framework
 * imporia: estado de um lado, efeitos que desenham do outro, e uma fronteira
 * clara entre eles.
 */

const estado = observavel({
  valor: 0,
  descricao: '',
  cliente: '',
  problemas: [],
  registros: [],
  online: navigator.onLine,
  souLider: false,
});

const resumo = derivado(() => resumir(estado.registros));

let bd;
const canal = criarCanal();
const eleicao = criarEleicao();

/** ------------------------------------------------------------ envio */

/**
 * Manda a cobrança para o servidor.
 *
 * A chave de idempotência vai no cabeçalho, que é a convenção que os meios de
 * pagamento adotam. É ela que faz o servidor reconhecer uma retentativa como o
 * mesmo pedido, em vez de cobrar de novo.
 */
async function enviarAoServidor(registro) {
  try {
    const resposta = await fetch('/api/cobrancas', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': registro.chave,
      },
      body: JSON.stringify({
        valor: registro.valor,
        descricao: registro.descricao,
        cliente: registro.cliente,
      }),
    });

    if (resposta.ok) {
      const dados = await resposta.json().catch(() => ({}));
      return { ok: true, id: dados.id };
    }

    const erro = await resposta.json().catch(() => ({}));
    return { ok: false, status: resposta.status, mensagem: erro.mensagem };
  } catch (erro) {
    // `fetch` só rejeita quando a requisição não completou: é falha de rede,
    // não recusa do servidor.
    return { ok: false, status: 0, mensagem: erro.message };
  }
}

/** ----------------------------------------------------------- ações */

async function recarregar() {
  estado.registros = await listar(bd);
}

async function confirmar() {
  const cobranca = {
    valor: estado.valor,
    descricao: estado.descricao.trim(),
    cliente: estado.cliente.trim(),
  };

  const problemas = problemasDaCobranca(cobranca);
  estado.problemas = problemas;

  if (problemas.length > 0) {
    // O foco vai para o primeiro campo com erro: sem isso, quem usa teclado ou
    // leitor de tela precisa procurar o que deu errado.
    document.querySelector(`[data-campo="${problemas[0].campo}"]`)?.focus();
    return;
  }

  /*
   * A chave nasce aqui, uma vez.
   *
   * Se ela fosse gerada no momento do envio, cada retentativa viraria uma
   * cobrança nova para o servidor, e uma rede instável produziria duplicatas.
   */
  await enfileirar(bd, { ...cobranca, chave: novaChave() });

  emLote(() => {
    estado.valor = 0;
    estado.descricao = '';
    estado.cliente = '';
    estado.problemas = [];
  });

  document.querySelector('campo-valor').valor = 0;
  await recarregar();

  canal.avisar({ tipo: 'fila-mudou' });
  document.querySelector('#descricao')?.focus();
}

async function descartar(chave) {
  await remover(bd, chave);
  await recarregar();
  canal.avisar({ tipo: 'fila-mudou' });
}

/** ------------------------------------------------------------ tela */

function desenharResumo() {
  const alvo = document.querySelector('#resumo');
  const { aguardando, valorAguardando, confirmadas, recusadas } = resumo.valor;

  alvo.innerHTML = `
    <div class="ficha ${aguardando > 0 ? 'ficha--atencao' : ''}">
      <span class="ficha__valor">${aguardando}</span>
      <span class="ficha__rotulo">na fila</span>
    </div>
    <div class="ficha">
      <span class="ficha__valor">${formatarBRL(valorAguardando)}</span>
      <span class="ficha__rotulo">aguardando</span>
    </div>
    <div class="ficha">
      <span class="ficha__valor">${confirmadas}</span>
      <span class="ficha__rotulo">confirmadas</span>
    </div>
    ${
      recusadas > 0
        ? `<div class="ficha ficha--erro">
             <span class="ficha__valor">${recusadas}</span>
             <span class="ficha__rotulo">recusadas</span>
           </div>`
        : ''
    }
  `;
}

function desenharFila() {
  const alvo = document.querySelector('#fila');
  const registros = estado.registros;

  if (registros.length === 0) {
    alvo.innerHTML = `
      <p class="vazio">
        Nenhuma cobrança ainda. As que você criar aparecem aqui, e continuam
        aqui mesmo se a internet cair no meio.
      </p>
    `;
    return;
  }

  alvo.innerHTML = registros
    .slice()
    .reverse()
    .map(
      (registro) => `
        <li class="linha linha--${registro.estado}">
          <div class="linha__corpo">
            <p class="linha__descricao">${escapar(registro.descricao)}</p>
            <p class="linha__cliente">${escapar(registro.cliente)}</p>
            ${
              registro.erro
                ? `<p class="linha__erro">${escapar(registro.erro)}</p>`
                : ''
            }
            ${
              registro.tentativas > 0 && registro.estado === ESTADOS.PENDENTE
                ? `<p class="linha__tentativas">tentativa ${registro.tentativas}</p>`
                : ''
            }
          </div>

          <div class="linha__lado">
            <span class="linha__valor">${formatarBRL(registro.valor)}</span>
            <span class="etiqueta etiqueta--${registro.estado}">
              ${ROTULO_DO_ESTADO[registro.estado]}
            </span>
          </div>

          ${
            registro.estado === ESTADOS.CONFIRMADA ||
            registro.estado === ESTADOS.RECUSADA
              ? `<button class="descartar" data-chave="${registro.chave}"
                   aria-label="Remover ${escapar(registro.descricao)} da lista">✕</button>`
              : ''
          }
        </li>
      `,
    )
    .join('');
}

/**
 * Escapa antes de inserir.
 *
 * A descrição e o e-mail vêm de quem digita. Sem escapar, uma descrição com
 * `<img onerror>` executa script na tela de quem abrir a fila, e num sistema de
 * cobrança isso alcança o valor exibido.
 */
function escapar(texto) {
  const elemento = document.createElement('span');
  elemento.textContent = String(texto ?? '');
  return elemento.innerHTML;
}

function desenharConexao() {
  const alvo = document.querySelector('#conexao');

  alvo.hidden = estado.online;
  alvo.textContent = estado.online
    ? ''
    : 'Sem conexão. As cobranças ficam guardadas e sobem quando a internet voltar.';
}

function desenharProblemas() {
  for (const campo of ['valor', 'descricao', 'cliente']) {
    const problema = estado.problemas.find((p) => p.campo === campo);
    const elemento = document.querySelector(`[data-erro="${campo}"]`);
    const entrada = document.querySelector(`[data-campo="${campo}"]`);

    if (elemento) elemento.textContent = problema?.mensagem ?? '';

    // `aria-invalid` é o que faz o leitor de tela anunciar o campo como
    // problemático, e a borda vermelha sozinha não informa isso.
    entrada?.setAttribute('aria-invalid', problema ? 'true' : 'false');
  }
}

/** ---------------------------------------------------------- ligação */

export async function iniciar() {
  bd = await abrirBanco();
  await recarregar();

  // Cada efeito desenha uma parte, e só acorda quando o que ele lê muda.
  // Redesenhar tudo a cada mudança perderia foco e posição de rolagem.
  efeito(desenharResumo);
  efeito(desenharFila);
  efeito(desenharConexao);
  efeito(desenharProblemas);

  document.querySelector('campo-valor').addEventListener('valor', (evento) => {
    estado.valor = evento.detail.centavos;
  });

  document.querySelector('#descricao').addEventListener('input', (evento) => {
    estado.descricao = evento.target.value;
  });

  document.querySelector('#cliente').addEventListener('input', (evento) => {
    estado.cliente = evento.target.value;
  });

  document.querySelector('#confirmar').addEventListener('click', () => void confirmar());

  document.querySelector('#fila').addEventListener('click', (evento) => {
    const chave = evento.target.closest('.descartar')?.dataset.chave;
    if (chave) void descartar(chave);
  });

  addEventListener('online', () => {
    estado.online = true;
  });

  addEventListener('offline', () => {
    estado.online = false;
  });

  // Outra aba mexeu na fila: recarrega para a tela não mentir.
  canal.aoReceber((mensagem) => {
    if (mensagem?.tipo === 'fila-mudou') void recarregar();
  });

  /*
   * Só a aba líder envia.
   *
   * Três abas abertas fariam três envios simultâneos da mesma cobrança. A
   * idempotência impede a cobrança dupla no servidor, e não impede o
   * desperdício nem a corrida ao gravar o resultado aqui.
   */
  await eleicao.disputar(() => {
    estado.souLider = true;

    iniciarSincronizacao({
      bd,
      enviar: enviarAoServidor,
      aoMudar: () => {
        void recarregar();
        canal.avisar({ tipo: 'fila-mudou' });
      },
    });
  });
}

if (typeof document !== 'undefined' && document.querySelector('#fila')) {
  void iniciar();
}
