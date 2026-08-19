# Caixa

**Fila de cobranças que sobrevive à queda de internet.** A pessoa conclui um
pagamento, a rede cai, e nada se perde nem duplica.

JavaScript puro. Sem React, sem build, sem bundler. Abre no navegador e funciona.

```bash
npm install
npm run dev      # http://localhost:4000
npm test         # 206 testes
npm run build    # minifica e mede o ganho real
```

**Sistema de design:** `http://localhost:4000/docs/` — a página lê o CSS
aplicado e calcula o contraste ao vivo, em vez de repetir valores escritos à
mão.

O servidor de demonstração **recusa 20% das chamadas de propósito**, e 10% em
definitivo. É assim que dá para ver a fila trabalhando: sem falha, um sistema de
retentativa parece código morto.

Para testar offline: ferramentas do navegador, aba Rede, marque "Offline". Crie
cobranças, volte a ficar online, e veja elas subirem sozinhas.

---

## O problema

Um checkout que só funciona com rede boa não funciona. Em conexão instável, três
coisas dão errado, e as duas primeiras têm saídas óbvias e ruins.

**A cobrança se perde.** Mostrar "tente de novo" joga fora o que a pessoa já
fez, e numa conexão ruim isso acontece repetidamente até ela desistir.

**A cobrança some ao fechar a aba.** Guardar em memória resolve até o navegador
ser fechado, e aí o pagamento desaparece sem ninguém saber que existiu.

**A cobrança duplica.** O caso difícil: o servidor processou, a resposta se
perdeu no caminho de volta, o cliente tenta de novo. Sem proteção, o cliente
paga duas vezes por um problema de rede.

## As decisões

### O disco vem antes da rede

A intenção é gravada em IndexedDB **antes** de qualquer tentativa de envio, e só
sai de lá depois da confirmação do servidor. Se o processo morrer no meio, ela
continua ali na próxima abertura.

O preço disso é a duplicata, e é aí que entra a próxima decisão.

### A chave de idempotência nasce uma vez

Gerada no momento em que a pessoa confirma, e reusada em **toda** tentativa. É o
que transforma "tentar de novo" em "confirmar o mesmo pedido" para o servidor,
em vez de "cobrar outra vez".

Gerar a chave no momento do envio pareceria equivalente e transformaria cada
retentativa numa cobrança nova. Há teste cobrindo exatamente o cenário: servidor
processa, resposta se perde, cliente reenvia, e **uma** cobrança existe no fim.

### Nem todo erro merece retentativa

| Resposta | O que acontece | Por quê |
|---|---|---|
| Rede caiu, 500, 503 | Volta para a fila | Costuma passar sozinho |
| 402, 422, 409 | Sai da fila como recusada | Cartão sem saldo não passa por insistência |

Insistir no que não vai mudar gasta bateria, incomoda o servidor e deixa
pendurado na fila algo que nunca vai sair.

### A espera cresce, e a volta da rede a cancela

O intervalo entre tentativas dobra e para em cinco minutos, com ruído de até 30%.

O ruído não é detalhe: uma queda que afeta mil pessoas produziria mil pedidos no
mesmo instante quando a rede voltasse, e o servidor cairia de novo.

E quando o navegador avisa que a conexão voltou, a espera é **zerada**. Ela
existia para não martelar uma rede que caiu, e a volta da rede é a única
informação nova que temos.

### Uma aba trabalha, as outras olham

Três abas abertas fariam três envios simultâneos da mesma cobrança. A
idempotência protege o servidor, e não impede o desperdício nem a corrida ao
gravar o resultado local.

A eleição usa `navigator.locks`, que o navegador resolve sozinho: quem pega a
trava fica com ela até a aba fechar ou travar. Fazer isso à mão exigiria pulsos
periódicos e um tempo de espera arbitrário, e uma aba lenta seria confundida
com uma aba morta.

As outras abas acompanham por `BroadcastChannel`. Sem isso, uma aba mostraria
"enviando" para sempre enquanto a outra já exibiu o comprovante.

---

## O que foi construído do zero

### Reatividade por rastreamento de leitura

```js
const estado = observavel({ valor: 0, registros: [] });

efeito(() => desenharFila());     // só acorda quando `registros` muda
efeito(() => desenharResumo());   // idem, sem declarar nada
```

Quando um efeito roda, o `Proxy` anota quais campos ele leu. Quando um campo
muda, só os efeitos que leram aquele campo rodam de novo. **Ninguém declara
dependência, e por isso ninguém esquece de atualizar a declaração.**

As alternativas: redesenhar tudo a cada mudança perde foco, seleção e posição de
rolagem; chamar `atualizarTela()` na mão funciona até alguém esquecer, e o
defeito aparece longe da causa.

Três detalhes que só aparecem implementando:

**Desinscrever antes de cada execução.** É o que permite dependência
condicional: um efeito que lê `b` só quando `a` é verdadeiro precisa parar de
acompanhar `b` quando `a` vira falso.

**`Object.is` em vez de `!==`.** Senão `NaN` dispara mudança contra si mesmo, já
que `NaN !== NaN`.

**Escrever sem rastrear.** Um efeito que lê o que ele mesmo escreve vira
recursão infinita. Foi o primeiro bug do projeto: o valor derivado incrementava
uma versão que ele próprio observava, e a pilha estourava.

### Máscara de dinheiro que não pula o cursor

O jeito ingênuo, `campo.value = formatar(campo.value)`, joga o cursor para o fim
a cada tecla. Quem edita no meio de um valor já digitado perde o lugar e precisa
reposicionar depois de cada caractere.

A saída: contar quantos **dígitos** existem antes do cursor, reformatar, e
recolocá-lo depois do mesmo número de dígitos. Separadores mudam de lugar; a
posição relativa aos dígitos, não.

```js
const digitosAntes = digitosAntesDe(textoAntigo, cursorAntigo);
campo.value = formatarBRL(paraCentavos(textoAntigo));
const posicao = posicaoDoCursor(campo.value, digitosAntes);
campo.setSelectionRange(posicao, posicao);
```

**Dinheiro é guardado em centavos, em inteiro.** `0.1 + 0.2` dá
`0.30000000000000004` em ponto flutuante, e num sistema de cobrança essa
diferença vira divergência de centavo no fechamento do dia. Dinheiro é contagem,
não medida.

### Documentação que mede em vez de afirmar

A página em `docs/` lê os tokens do documento com `getComputedStyle` e calcula a
razão de contraste de cada combinação que o produto realmente usa.

Isso muda o que a documentação é. Uma tabela de cores escrita à mão envelhece no
primeiro ajuste de token e passa a mentir em silêncio, e alguém confia nela para
tomar uma decisão errada. Uma que calcula a partir do valor atual não tem como
divergir do produto.

**E ela achou dois defeitos na primeira execução.** As etiquetas de "confirmada"
e "recusada" davam 3,58 e 4,41 de contraste sobre o próprio fundo claro, abaixo
do mínimo de 4,5. Os tons vieram da escala padrão do Tailwind, que passa em
muitos pares e não naquele.

A paleta foi corrigida, e um teste agora impede a regressão: a documentação
mostra o problema para quem abre, o teste impede que ele entre.

### Web Vitals medidos, não estimados

A documentação mede LCP, CLS, INP, TTFB e FCP com `PerformanceObserver`, sem
biblioteca. Os números são desta página, e mudam conforme você navega.

A `web-vitals` do Google existe para normalizar diferenças entre navegadores e
lidar com bfcache, não para calcular algo que só ela sabe. Implementar as três
principais deixa claro **o que está sendo medido**, e duas sutilezas do CLS só
aparecem assim:

**Deslocamento causado por interação não conta.** Abrir um acordeão empurra o
conteúdo, e isso é esperado: a pessoa pediu. Contar puniria interface interativa.

**O valor não é a soma de tudo**, é a maior janela de cinco segundos. Somar
puniria uma página aberta por horas, onde cada rolagem acrescentaria um pouco.

### Minificação, com a medida honesta

`npm run build` minifica CSS e JS sem ferramenta externa e mostra o tamanho
antes, depois, e **depois do gzip**, que é o que a pessoa realmente baixa.

O resultado contrariou minha expectativa, e o relatório explica por quê:

| O que é removido | Ganho cru | Ganho depois do gzip |
|---|---|---|
| Espaço em branco | 8% | 3% |
| Comentários | 60% | **69%** |

Espaço repetido comprime quase a zero, como esperado. Prosa tem vocabulário
variado e comprime mal, então removê-la rende de verdade. **Num código bem
comentado, o comentário domina o tamanho, e não a formatação.**

O minificador de JS percorre caractere a caractere em vez de aplicar expressões
regulares no arquivo inteiro, porque a barra abre comentário, começa expressão
regular e é divisão. Distinguir os três por texto é o que quebra minificador
amador, e há teste com `a / b / c` ao lado de `/ab+c/`.

E o teste que importa mais: **o pacote minificado é importado e executado**,
incluindo o próprio minificador minificando.

### Componentes com Shadow DOM

O estilo do componente não vaza e o de fora não entra. Num componente de
pagamento isso importa mais que o normal: uma regra global mal escrita não pode
esconder o valor que a pessoa vai pagar.

As variáveis CSS atravessam a fronteira de propósito, e é assim que o tema
escuro funciona sem o componente saber que ele existe.

---

## Estrutura

```
nucleo/
├── reativo.js         Proxy, efeitos, lote, valor derivado
├── fila.js            IndexedDB, estados, espera entre tentativas
├── sincronizador.js   envio em série, eleição de aba, canal entre abas
├── cobranca.js        validação e chave de idempotência
├── contraste.js       luminância e razão de contraste da WCAG
├── vitais.js          LCP, CLS, INP com PerformanceObserver
└── minificar.js       minificação de CSS e JS sem ferramenta
componentes/
└── campo-valor.js     Web Component com máscara que preserva o cursor
docs/
└── index.html         sistema de design, com contraste medido ao vivo
app.js                 liga estado, fila e tela
servidor.js            demonstração com falhas de propósito
construir.js           gera o pacote e mede o ganho real
```

O núcleo não conhece o DOM. É por isso que ele é testável em Node puro, e é o
que permitiria trocar a interface sem tocar nas regras.

---

## Testes

**206 testes**, sem navegador de verdade: `fake-indexeddb` para a fila e `jsdom`
para os componentes.

| Arquivo | O que prova |
|---|---|
| `reativo` | Rastreamento, dependência condicional, lote, cancelamento |
| `fila` | Durabilidade, idempotência local, classificação de erro, espera |
| `sincronizador` | Ordem, chave estável entre tentativas, uma passada por vez |
| `campo-valor` | Cursor preservado, centavos inteiros, formatação |
| `cobranca` | Validação completa, limites nas bordas |
| `contraste` | Luminância, mistura de translúcido, limites da WCAG |
| `paleta` | Toda combinação em uso, nos dois temas, lida do CSS |
| `integracao` | Os casos que motivam o projeto, de ponta a ponta |
| `servidor` | Idempotência de verdade, e o que não deve ser servido |
| `vitais` | Janela do CLS, pior INP, ausência de suporte |
| `minificar` | Expressão regular versus divisão, string preservada |
| `construir` | O pacote minificado carrega e executa |

Os três que mais importam:

**Sobrevive a três falhas seguidas e é cobrado uma vez só.**

**Resposta perdida depois do processamento não cobra duas vezes.** É o caso mais
difícil, e a razão de existir da chave de idempotência.

**A fila continua depois de reabrir o banco.** Equivale a fechar a aba no meio e
voltar depois.

---

## O que ficou de fora, e por quê

**Service Worker com Background Sync.** Enviaria a fila mesmo com a aba fechada,
e só funciona em navegadores baseados em Chromium. A fila em IndexedDB continua
sendo necessária de qualquer forma, então isso seria uma camada a mais, não uma
substituição.

**Limpeza de registros antigos.** Confirmadas ficam até serem descartadas à mão.
Numa aplicação real, um prazo de validade e uma limpeza na abertura.

**Autenticação.** O servidor é de demonstração e aceita qualquer chamada.

## Licença

MIT
