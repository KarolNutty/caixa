import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  formatarBytes,
  medirGanho,
  minificarCSS,
  minificarJS,
} from '../nucleo/minificar.js';

describe('CSS', () => {
  it('remove comentários', () => {
    expect(minificarCSS('/* nota */ .a { cor: red; }')).toBe('.a{cor:red}');
  });

  it('remove o ponto e vírgula final', () => {
    expect(minificarCSS('.a { cor: red; }')).toBe('.a{cor:red}');
  });

  it('junta regras sem espaço desnecessário', () => {
    expect(minificarCSS('.a {\n  cor: red;\n}\n\n.b {\n  cor: blue;\n}')).toBe(
      '.a{cor:red}.b{cor:blue}',
    );
  });

  it('preserva o espaço dentro de aspas', () => {
    /**
     * `content: "  "` tem espaço significativo, e comê-lo mudaria o que
     * aparece na tela. É o caso que separa um minificador cuidadoso de um que
     * só aplica expressões regulares.
     */
    const fonte = '.a::before { content: "  dois espaços  "; }';
    expect(minificarCSS(fonte)).toContain('"  dois espaços  "');
  });

  it('não confunde comentário dentro de string', () => {
    const fonte = '.a { content: "/* isto não é comentário */"; }';
    expect(minificarCSS(fonte)).toContain('/* isto não é comentário */');
  });

  it('preserva o espaço entre seletores descendentes', () => {
    // `.a .b` e `.a.b` significam coisas diferentes.
    expect(minificarCSS('.a .b { cor: red }')).toBe('.a .b{cor:red}');
  });
});

describe('JavaScript', () => {
  it('remove comentário de linha', () => {
    expect(minificarJS('const a = 1; // nota\nconst b = 2;')).toBe(
      'const a=1;const b=2;',
    );
  });

  it('remove comentário de bloco', () => {
    expect(minificarJS('/* nota */ const a = 1;')).toBe('const a=1;');
  });

  it('mantém o espaço que separa palavras', () => {
    // Sem ele, `const a` vira `consta`, que é outro identificador.
    expect(minificarJS('const   a   =   1')).toBe('const a=1');
  });

  it('não toca no conteúdo de string', () => {
    const fonte = 'const a = "  dois  espaços  ";';
    expect(minificarJS(fonte)).toContain('"  dois  espaços  "');
  });

  it('não toca em modelo com crase', () => {
    const fonte = 'const a = `linha um\n  linha dois`;';
    expect(minificarJS(fonte)).toContain('linha um\n  linha dois');
  });

  it('comentário dentro de string continua lá', () => {
    const fonte = 'const a = "// isto não é comentário";';
    expect(minificarJS(fonte)).toContain('// isto não é comentário');
  });

  it('distingue expressão regular de divisão', () => {
    /**
     * A barra abre comentário, começa expressão regular e é divisão. Errar aqui
     * transforma `a / b / c` numa expressão regular e corrompe o arquivo, e é o
     * caso que quebra minificador amador.
     */
    expect(minificarJS('const x = a / b / c;')).toBe('const x=a/b/c;');
    expect(minificarJS('const r = /ab+c/;')).toBe('const r=/ab+c/;');
  });

  it('barra dentro de expressão regular não a encerra', () => {
    const fonte = 'const r = /a\\/b/;';
    expect(minificarJS(fonte)).toContain('/a\\/b/');
  });

  it('barra dentro de classe de caractere também não', () => {
    const fonte = 'const r = /[/]/;';
    expect(minificarJS(fonte)).toContain('[/]');
  });

  it('o resultado ainda executa', () => {
    // O teste que importa mais: minificar sem quebrar.
    const fonte = `
      // soma dois números
      export function somar(a, b) {
        /* nada demais */
        const total = a + b;
        return total;
      }
    `;

    const minificado = minificarJS(fonte);
    const executavel = minificado.replace('export ', '');

    // eslint-disable-next-line no-new-func
    const somar = new Function(`${executavel}; return somar;`)();

    expect(somar(2, 3)).toBe(5);
  });

  it('código com expressão regular e divisão junto continua funcionando', () => {
    const fonte = `
      function processar(texto, divisor) {
        const limpo = texto.replace(/\\s+/g, ' ');
        return limpo.length / divisor;
      }
    `;

    const minificado = minificarJS(fonte);
    // eslint-disable-next-line no-new-func
    const processar = new Function(`${minificado}; return processar;`)();

    expect(processar('a  b  c', 2)).toBe(2.5);
  });
});

describe('medição do ganho', () => {
  const comprimir = (texto) => gzipSync(Buffer.from(texto));

  it('relata o tamanho antes e depois', () => {
    const relatorio = medirGanho('a  =  1', 'a=1');

    expect(relatorio.cru.antes).toBe(7);
    expect(relatorio.cru.depois).toBe(3);
  });

  it('relata também o tamanho comprimido', () => {
    /**
     * O número que importa: todo servidor sério manda gzip, e espaço repetido
     * comprime quase a zero. Anunciar "60% menor" contando espaço em branco é
     * medir o que o gzip já resolvia de graça.
     */
    const original = 'const a = 1;\n\n\n'.repeat(200);
    const relatorio = medirGanho(original, minificarJS(original), comprimir);

    expect(relatorio.reducaoCrua).toBeGreaterThan(relatorio.reducaoReal);
  });

  it('sem compressor, devolve só o cru', () => {
    expect(medirGanho('aa', 'a').comprimido).toBeUndefined();
  });
});

describe('formatação de tamanho', () => {
  it('bytes abaixo de um kB', () => {
    expect(formatarBytes(512)).toBe('512 B');
  });

  it('kilobytes acima disso', () => {
    expect(formatarBytes(2048)).toBe('2.0 kB');
  });
});
