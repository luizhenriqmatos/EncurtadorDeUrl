# Encurtador de URL

Cole uma URL grande, receba um link curto e um QR Code, e acompanhe os cliques.

## Recursos

- Geração de código curto (7 caracteres, sem caracteres ambíguos) e QR Code PNG/SVG
- Expiração por prazo (1, 7, 30, 90 dias) ou data exata; link pode ser desativado manualmente
- Redirecionamento 302 que registra cada clique (origem via `utm_source` ou referer, dispositivo, navegador, país quando o proxy envia o cabeçalho)
- Painel do link: cliques totais, últimos 7 dias, visitantes únicos, gráfico de 30 dias, origens, dispositivos, navegadores, países, dias com mais cliques e últimos cliques
- Painel admin: visão geral da plataforma, links com mais cliques e usuários
- Contas com senha em `scrypt`, sessão em cookie `HttpOnly`/`SameSite=Lax`

## Rodar

```bash
npm install
npm start            # http://localhost:3000
npm test             # testes de API (node:test)
```

Variáveis de ambiente:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `3000` | porta HTTP |
| `DB_FILE` | `data/encurtador.db` | arquivo SQLite |
| `PUBLIC_BASE_URL` | host da requisição | domínio usado nos links curtos, ex. `https://enc.exemplo.com` |
| `ADMIN_EMAIL` | — | e-mail que recebe papel admin no cadastro (o primeiro cadastro também vira admin) |
| `VISITOR_SALT` | aleatório a cada boot | sal do hash de visitantes únicos; fixe em produção |
| `NODE_ENV` | — | `production` ativa cookie `Secure` |

Requer Node 22.13+ (usa `node:sqlite`) e `qrcode` como única dependência.

## Estrutura

```
src/
  server.js   entrada HTTP
  app.js      rotas da API, front estático e redirecionamento
  auth.js     senha (scrypt) e sessões
  links.js    código curto, validação de URL, expiração e status
  stats.js    registro de cliques, filtro de bots e agregações
  db.js       schema SQLite
  http.js     helpers HTTP
public/
  index.html, styles.css, app.js   interface (SPA com hash routing, SVG sem biblioteca de gráficos)
  thinking-orbs.js                 Thinking Orbs © 2026 Jakub Antalik, MIT (licença preservada no arquivo)
test/
  api.test.js
```

## Notas

- Cliques de bots e ferramentas de preview (`bot`, `crawl`, `curl`, `facebookexternalhit` etc.) não são contados.
- O IP nunca é armazenado: só entra num hash diário junto com o User-Agent, usado para visitantes únicos.
- Não há rate limit nem proteção contra abuso de cadastro; adicione antes de expor publicamente.
- Geolocalização de país depende de um cabeçalho do proxy (`cf-ipcountry`, `x-vercel-ip-country`); sem ele aparece "Desconhecido".
