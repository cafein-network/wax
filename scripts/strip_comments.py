"""Remove comments from release source files (JavaScript, CSS, HTML, Python) without changing behavior."""
import io
import re
import tokenize

REGEX_AFTER = set('(,=:[!&|?{};+-*%<>~^')
REGEX_KEYWORDS = {'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'}


def _drop_blank(original, stripped):
    """Drop lines that held only a comment. Lines the stripper did not touch (string contents included) stay byte for byte."""
    out = []
    for before, after in zip(original.split('\n'), stripped.split('\n')):
        if after == before:
            out.append(after)
        elif after.strip():
            out.append(after.rstrip())
    return '\n'.join(out)


def strip_js(source):
    out = []
    i, n = 0, len(source)
    last = ''
    before_last = ''
    word = ''
    stack = []

    def emit(text):
        out.append(text)

    if source.startswith('#!'):
        end = source.find('\n')
        emit(source[:end + 1] if end >= 0 else source)
        i = end + 1 if end >= 0 else n
    while i < n:
        c = source[i]
        nxt = source[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            end = source.find('\n', i)
            i = n if end < 0 else end
            continue
        if c == '/' and nxt == '*':
            end = source.find('*/', i + 2)
            if end < 0:
                raise ValueError('unterminated block comment')
            emit('\n' * source.count('\n', i, end) if '\n' in source[i:end] else ' ')
            i = end + 2
            continue
        if c in '\'"':
            j = i + 1
            while j < n and source[j] != c:
                if source[j] == '\\':
                    j += 1
                elif source[j] == '\n':
                    raise ValueError('unterminated string')
                j += 1
            emit(source[i:j + 1])
            i, last, word = j + 1, c, ''
            continue
        if c == '`' or (c == '}' and stack and stack[-1] == 0):
            if c == '}':
                stack.pop()
            j = i + 1
            while j < n:
                if source[j] == '\\':
                    j += 2
                    continue
                if source[j] == '`':
                    break
                if source[j] == '$' and j + 1 < n and source[j + 1] == '{':
                    stack.append(0)
                    j += 1
                    break
                j += 1
            if j >= n:
                raise ValueError('unterminated template literal')
            emit(source[i:j + 1])
            i = j + 1
            if source[j] == '`':
                last, word = '`', ''
            else:
                last, word = '{', ''
            continue
        postfix = last in '+-' and before_last == last
        if c == '/' and not postfix and (last in REGEX_AFTER or last == '' or word in REGEX_KEYWORDS):
            j, in_class = i + 1, False
            while j < n:
                ch = source[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == '\n':
                    raise ValueError('unterminated regular expression')
                if ch == '[':
                    in_class = True
                elif ch == ']':
                    in_class = False
                elif ch == '/' and not in_class:
                    break
                j += 1
            j += 1
            while j < n and (source[j].isalpha()):
                j += 1
            emit(source[i:j])
            i, last, word = j, '/', ''
            continue
        if c == '{' and stack:
            stack[-1] += 1
        elif c == '}' and stack:
            stack[-1] -= 1
        emit(c)
        if c.isalnum() or c in '_$':
            word = word + c if (last.isalnum() or last in '_$') else c
            last = c
        elif not c.isspace():
            before_last, last, word = last, c, ''
        i += 1
    return _drop_blank(source, ''.join(out))


def strip_css(source):
    return _drop_blank(source, re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), source, flags=re.S))


def strip_html(source):
    return _drop_blank(source, re.sub(r'<!--.*?-->', lambda m: '\n' * m.group(0).count('\n'), source, flags=re.S))


def strip_python(source):
    tokens = [t for t in tokenize.generate_tokens(io.StringIO(source).readline)
              if not (t.type == tokenize.COMMENT and not (t.start[0] == 1 and t.string.startswith('#!')))]
    return _drop_blank(source, tokenize.untokenize(tokens))


STRIPPERS = {'.mjs': strip_js, '.js': strip_js, '.css': strip_css, '.html': strip_html, '.py': strip_python}


def strip(name, text):
    for suffix, fn in STRIPPERS.items():
        if name.endswith(suffix):
            return fn(text)
    return text


if __name__ == '__main__':
    import sys
    from pathlib import Path
    for name in sys.argv[1:]:
        path = Path(name)
        path.write_text(strip(path.name, path.read_text(encoding='utf-8')), encoding='utf-8')
