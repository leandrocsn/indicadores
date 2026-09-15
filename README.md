# Gestão à Vista — Geoteste

Painel estático de indicadores. Não há nada para compilar: o site é o próprio
`index.html`, com dados, imagens e scripts embutidos no arquivo.

## Publicar no Netlify

**Pela pasta (mais simples):** arraste esta pasta inteira para o Netlify Drop
(app.netlify.com/drop). Em segundos o site está no ar.

**Pelo GitHub:** suba estes arquivos na raiz do repositório e conecte o repositório
no Netlify. Nas configurações de build:

- Build command: *deixe em branco*
- Publish directory: `.` (ponto)

Se o Netlify preencher algum comando sozinho, apague. Qualquer comando de build
falha, porque não existe `package.json` neste projeto.

## Atenção

O painel contém dados internos da empresa, inclusive valores de gratificação por
colaborador. **Use repositório privado** e, no Netlify, considere proteger o site
por senha (Site settings → Access control → Password protection).
