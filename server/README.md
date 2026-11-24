# Servidor da Biblioteca de Musculação

Worker TypeScript compatível com Web APIs de Cloudflare: `fetch`, Web Crypto, streams e cookies. Não depende de Node no servidor. A interface Vite é servida por `env.ASSETS`; o empacotador pode fornecer um adaptador equivalente. O código de produção é `server/index.ts`.

## Situação desta entrega

As rotas e as regras estão implementadas e foram verificadas com testes locais que simulam respostas oficiais. Supabase, Bunny, SMTP e Mercado Pago reais **não foram conectados** nesta execução, porque as credenciais e as contas de Professor não foram fornecidas. A biblioteca começa vazia; os vídeos ilustrativos foram retirados. Os endpoints protegidos retornam `503 INTEGRATION_PENDING` quando falta uma integração; não criam sessões ou pagamentos fictícios.

Antes de vender, é obrigatória a homologação ponta a ponta em contas de teste, a proteção da biblioteca Bunny, a confirmação dos e-mails e a aprovação dos textos comerciais. `PAYMENTS_ENABLED` e `BUNNY_SECURITY_CONFIRMED` começam desabilitados. O checkout também exige as credenciais de vídeo e a confirmação da proteção do Bunny, para não vender antes da configuração da reprodução.

## Configuração do Worker

| Binding/segredo | Uso |
|---|---|
| `APP_ORIGIN` | Origem HTTPS exata da aplicação, sem barra final. Produção e homologação têm valores diferentes. |
| `SUPABASE_URL` | `https://PROJECT.supabase.co` |
| `SUPABASE_ANON_KEY` | Chave `sb_publishable_...` ou chave legada `anon`. Fica no Worker nesta arquitetura. |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave `sb_secret_...` ou chave legada `service_role`. Cadastrar como segredo do Worker. |
| `RATE_LIMIT_SALT` | Valor aleatório de ao menos 32 bytes, usado para derivar identificadores de limitação sem guardar IP em claro. |
| `BUNNY_STREAM_LIBRARY_ID` | ID numérico da biblioteca privada. |
| `BUNNY_STREAM_API_KEY` | Chave de gerenciamento e assinatura temporária de envio. |
| `BUNNY_EMBED_TOKEN_KEY` | Chave específica de autenticação dos embeds. Não confundir com a chave de API. |
| `BUNNY_SECURITY_CONFIRMED` | `true` somente após configurar e testar os controles da biblioteca e CDN. |
| `MERCADO_PAGO_ACCESS_TOKEN` | Credencial do vendedor e ambiente corretos. |
| `MERCADO_PAGO_COLLECTOR_ID` | ID do recebedor, conferido em cada pagamento consultado. |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Segredo de HMAC gerado em Suas integrações → Webhooks. |
| `MERCADO_PAGO_LIVE_MODE` | Exatamente `false` em teste ou `true` em produção. Não misturar recursos entre ambientes. |
| `PAYMENTS_ENABLED` | `true` após homologação e aprovação comercial. Além disso, o plano e todos os flags legais no banco precisam estar aprovados. |
| `ASSETS` | Binding de arquivos estáticos Vite ou adaptador de assets do empacotador. |

Executar as migrações Supabase na ordem `001_initial.sql`, `002_professor_version_scope.sql`. As tabelas e RPCs privilegiadas não têm acesso de escrita a partir do navegador. A primeira migração cria `materials` privado e `thumbnails` público; miniaturas são imagens editoriais sem dados pessoais. O Worker faz o upload administrativo e fornece o endereço público de uma miniatura por uma rota controlada. A segunda migração preserva dados legados, retira publicação de vídeos fora do novo requisito de duração e preenche contatos ainda vazios. A biblioteca de apoio e suas rotas foram removidas desta versão; não há emissão de autorizações ou upload de materiais.

Configure SMTP próprio no painel Auth, verificação de e-mail obrigatória, mínimo de senha de 12 caracteres e limites do provedor. O Worker também limita tentativas em uma RPC atômica, por IP derivado e, onde necessário, por conta/e-mail. `CF-Connecting-IP` só é confiável quando o Worker recebe o tráfego diretamente pela Cloudflare. Configure proteção de CAPTCHA no Supabase se a chave pública for exposta em futuras integrações; a limitação da aplicação não substitui a limitação do endpoint Auth do fornecedor.

O primeiro administrador é promovido por operação administrativa controlada no banco após criar e verificar sua conta. Nunca aceitar `role`, `enabled` ou gratuidade no cadastro. Todas as novas contas começam com papel `user`. Não há API no navegador para promover administradores.

## Sessões, confirmação e MFA

O navegador usa exclusivamente cookies `__Host-dm_access` e `__Host-dm_refresh`, com `HttpOnly`, `Secure`, `SameSite=Lax` e `Path=/`. Tokens não são devolvidos no JSON nem gravados em localStorage. O acesso é validado por `GET /auth/v1/user` a cada operação protegida, seguido de consulta do perfil habilitado. A renovação de sessão também é feita no Worker. Nas mutações, o header `Origin` deve ser exatamente `APP_ORIGIN`; o webhook tem autenticação própria.

Os claims do JWT só são lidos depois de o mesmo token ser validado pelo Supabase. Administradores precisam de `aal2` para painel e reprodução; as rotas de configuração/validação de MFA aceitam o administrador em `aal1` para concluir o fluxo. A lista dos fatores vem do usuário autenticado, sem confiar em ID de outro usuário.

Nos templates de **Confirmação**, **Convite** e **Recuperação** do Supabase, use links para a aplicação contendo `token_hash={{ .TokenHash }}` e respectivamente `type=signup`, `type=invite`, `type=recovery`. Exemplo de destino:

```html
<a href="{{ .SiteURL }}/confirm?token_hash={{ .TokenHash }}&amp;type=recovery">Definir minha senha</a>
```

Definir `Site URL` como `APP_ORIGIN`. A tela da aplicação lê os parâmetros, remove o segredo do endereço com `history.replaceState` e, **após clique do usuário**, chama `POST /api/auth/confirm`. Não consuma o token automaticamente por GET, evitando scanners de e-mail que esgotam o link. Para convite/recuperação, mostrar o formulário e chamar `/api/auth/reset`. A nova senha encerra os refresh tokens das sessões; um access token já emitido pode durar até a expiração configurada no Supabase. Recomenda-se JWT de 15 minutos, testando renovação automática.

Remetente deve usar domínio de Professor, SPF/DKIM e política DMARC configurados; testar convite, confirmação, recuperação, spam e devolução em provedores diferentes. E-mail ainda depende de domínio, conta SMTP e configuração real.

## API da interface

Todas as rotas começam por `/api`. JSON de erro: `{error: 'CODIGO', message: 'Mensagem em português'}`. As respostas da API têm `Cache-Control: private, no-store`; o Worker não habilita CORS. Mutações JSON enviam `Content-Type: application/json`, inclusive quando o corpo é `{}`.

| Método e rota | Contrato |
|---|---|
| `GET /health` | `{ok, application, configured}`. Não testa pagamento/reprodução nem expõe segredos. |
| `GET /config` | `{configured,demo,contacts:{instagram,whatsapp},plan:{enabled,price_cents,period_days,name,renewal:'manual'},banner,logo_url}`. Sem credenciais: demonstração explícita e vendas desativadas. |
| `GET /catalog` | Busca pública de metadados publicados/prontos. Query: `q`, `level=beginner|intermediate|advanced`, `muscle`, `category`, `equipment` por slug, `cursor` UUID. Retorno `{items,next_cursor}`; páginas de 18. Busca título, exercício, descrição e palavras-chave sem diferenciar acento/caixa. |
| `GET /taxonomies` | `{items:[{id,kind,name,slug}]}`. `kind=muscle|category|equipment`. |
| `POST /auth/signup` | `{email,password,display_name}`. Retorna 202 e pede verificação. Não concede matrícula. |
| `POST /auth/signin` | `{email,password}` → `{signed_in,mfa_required}` e cookies. |
| `POST /auth/recover` | `{email}` → resposta genérica 202 sem enumerar contas. |
| `POST /auth/confirm` | `{token_hash,type}` → `{verified,set_password}` e cookies. |
| `POST /auth/reset` | `{password}` com sessão verificada → mensagem, encerra sessão. |
| `POST /auth/signout` | `{}` → encerra sessão e apaga cookies mesmo se já expirou. |
| `POST /auth/mfa/enroll` | `{}` → `{id,type,totp:{qr_code,secret,uri}}` do Supabase. Só mostrar o segredo ao administrador que o solicita. |
| `POST /auth/mfa/verify` | `{factor_id,code}` de seis dígitos → `{verified}` e cookies AAL2. |
| `GET /account` | `{user:{id,email},profile:{id,display_name,role,enabled},entitlement:boolean,grants,subscriptions,orders,favorites:[video_id],aal,factors}`. Exige conta habilitada/verificada, mas pode ainda não ter direito ao conteúdo. |
| `PATCH /account` | Apenas `{display_name}`. Não permite mudar privilégios. |
| `GET /favorites` | Conteúdos prontos/publicados salvos pela própria conta. |
| `POST /favorites/:id` e `DELETE /favorites/:id` | Salva/remove da própria lista. Nunca recebe um ID de proprietário pelo corpo. |
| `GET /watch/:id` | Conta com acesso → `{video,embed_url,expires_at,related}`. |
| `POST /checkout` | `{}`; servidor decide conta, plano, valor, moeda e prazo → `{order_id,checkout_url}`. |
| `POST /orders/:id/refresh` | `{}`; consulta somente pedido da própria conta. O retorno do checkout não libera acesso. |

Cada item de catálogo contém `id,title,exercise,description,difficulty,duration_seconds,thumbnail_url,keywords,taxonomies`. O GUID do Bunny e os caminhos privados nunca integram o catálogo público. A lista é pública para apresentar a oferta; o vídeo exige autorização no servidor. Todas as rotas antigas `/api/materials` e `/api/admin/materials`, incluindo caminhos descendentes, retornam `404` sem consultar fornecedores, inclusive para administradores.

## API administrativa

Todas as rotas a seguir exigem administrador habilitado, e-mail confirmado e MFA AAL2. As operações registram resumos administrativos sem segredos, senhas ou corpos completos de pagamento.

| Método e rota | Corpo/retorno principal |
|---|---|
| `GET /admin/overview` | Listas iniciais de usuários (com e-mail), vídeos, matrículas, assinaturas e pedidos. Os limites desta visão são de paginação, não limites de cadastro. |
| `GET /admin/users?page=1` | `{items,next_page}`, páginas de 50. |
| `POST /admin/users/invite` | `{email,display_name}`. O aluno define sua senha pelo e-mail. |
| `PATCH /admin/users/:id/block` | `{enabled:false}` bloqueia; `true` reativa. Administrador não pode se bloquear. Não altera matrícula ou pagamentos. |
| `POST /admin/users/:id/grants` | `{expires_at?:ISO|null}` cria concessão gratuita. |
| `PATCH /admin/grants/:id` | `{status:'active'|'cancelled',expires_at?:ISO|null}` reativa/cancela somente aquela matrícula. |
| `GET/POST /admin/videos` | Lista paginada (`cursor`) ou cria rascunho com `{title}`. |
| `GET/PATCH /admin/videos/:id` | Edita `title,exercise,description,difficulty,keywords,taxonomy_ids`. Não aceita GUID, status ou publicação arbitrários pelo PATCH. |
| `POST /admin/videos/:id/upload` | `{}` → `{endpoint,videoId,libraryId,expirationTime,signature}`. Assinatura de upload de uma hora. Reassina somente vídeo remoto ainda sem envio (`status=0`). |
| `POST /admin/videos/:id/refresh` | `{}` consulta estado e duração pela API Bunny; excesso de 180 segundos mantém o vídeo despublicado e retorna `publication_error`. |
| `POST /admin/videos/:id/publish` | `{published:true|false}`; para publicar, verifica processamento real, duração válida de até 180 segundos, miniatura e proteção da biblioteca. |
| `POST /admin/videos/:id/thumbnail` | Multipart `file`; JPEG/PNG, até 2 MiB. |
| `GET/POST /admin/taxonomies` | Lista ou cria `{kind,name,slug}`. |
| `PATCH/DELETE /admin/taxonomies/:id` | Edita nome ou remove categoria sem referências. Remover associações dos vídeos antes de excluir categoria utilizada. |
| `GET/PATCH /admin/settings` | `{key:'public'|'plan'|'legal',value:{...}}`; campos permitidos validados e auditados. |
| `POST /admin/reconcile` | `{}` recupera atualizações de pagamento; retorna `{checked,failed}`. |

Configuração `public`: `instagram_url`, `whatsapp_number` com DDI/DDD somente dígitos, `banner_enabled`, `banner_title`, `banner_text`, `banner_url`, `logo_url`. Nome do produto é fixo; banners são opcionais. `plan`: `enabled,title,amount_cents,currency:'BRL',period_days`. `legal`: `approved,cancellation_approved,terms_approved,privacy_approved`; grava administrador e data da confirmação. Isso registra uma aprovação; não substitui a revisão real e publicação do texto correspondente.

Contatos iniciais: Instagram `https://www.instagram.com/seu_perfil/` e WhatsApp `5511900000000` (`+55 11 90000-0000`, exatamente como fornecido). Ambos continuam editáveis pelo administrador. O mesmo contato aparece na demonstração e como padrão quando a configuração real está ausente; não é inserido um nono dígito no número fornecido.

## Upload, reprodução e arquivos

Vídeos são enviados diretamente do navegador ao TUS Bunny usando `tus-js-client`; a chave de gerenciamento nunca sai do Worker. A interface usa progresso do TUS para envio e consulta `/refresh` para processamento. A API de **consulta de vídeo** é usada para decidir disponibilidade, não o status ou a duração enviados pelo navegador. A publicação verifica a duração bruta: 180 segundos são aceitos; 180,1 segundos são recusados. Duração ausente ou inválida também impede publicação. Upload e processamento permanecem disponíveis para conferir o arquivo. O enum de webhooks Bunny é diferente do enum `VideoModelStatus` usado no SDK de consulta; homologar a transição com um vídeo real na biblioteca escolhida. Aqui `GET status=4` é tratado como concluído, `5/6` como falha, demais como processamento. Não há webhook Bunny nesta implementação. A possibilidade de chegar a 500 vídeos é expansão futura a avaliar com Professor; não há limite automático de quantidade nesta versão.

No Bunny: ativar autenticação de embed; restringir domínios de incorporação; proteger também URLs diretas de HLS/segmentos/MP4 pela CDN/MediaCage disponível no plano; desabilitar download e MP4 fallback se não necessário; configurar player com qualidade adaptativa, velocidade e tela cheia. Validar com navegador que link direto sem token e embed expirado retornam recusa. Somente então definir `BUNNY_SECURITY_CONFIRMED=true`.

Embeds usam o algoritmo oficial `SHA256_HEX(chave + videoId + expires)` e duram 10 minutos. Ao cancelar matrícula ou bloquear uma conta, novas autorizações são recusadas; uma autorização já emitida pode durar até expirar. Tokens são portadores: quem obtém um link válido pode usá-lo durante essa janela. Gravação de tela e captura por usuário autorizado não podem ser impedidas completamente. DRM adicional depende de custo e compatibilidade e não está incluído.

Materiais foram retirados desta versão por decisão do responsável; tabelas e objetos privados legados são preservados sem exposição na aplicação. O Worker confere tamanho e assinatura binária básica das miniaturas JPEG/PNG, que aceitam até 2 MiB; não é um serviço antivírus. Miniaturas SVG e conteúdo HTML não são aceitos. Substituições podem deixar versões anteriores para limpeza periódica controlada; backups devem guardar também os objetos usados, não apenas a tabela.

## Pagamentos e reconciliação

A primeira integração é **Checkout Pro hospedado, pagamento único por Pix ou cartão e renovação manual**. Não cria assinatura recorrente automática, débito recorrente no cartão ou Pix Automático. O vendedor precisa habilitar os meios em sua conta. Cartões são digitados no ambiente do Mercado Pago. Não há campos de cartão no Worker ou na aplicação.

`create_payment_order` bloqueia atomicamente a conta ao criar/reutilizar pedido, com snapshot de valor/título/prazo. Pedido pendente é reaproveitado por até 24 horas; uma mudança posterior de plano não altera o pedido anterior. A renovação é oferecida quando termina o período pago, evitando venda de termos sobrepostos. Gratuidade e pagamento continuam em registros independentes.

Cada notificação de `payment` precisa de `x-signature` e `x-request-id`. HMAC-SHA256 valida o manifesto `id:...;request-id:...;ts:...;`, usando **data.id da query** e comparação constante. A tolerância de relógio é de cinco minutos; avisos mais antigos são recuperados por reconciliação, sem relaxar a autenticação. O servidor consulta `/v1/payments/:id`, verifica referência externa UUID, recebedor, moeda, valor, ambiente e data original de aprovação, e só então chama `process_payment` transacional. O prazo pago começa em `date_approved`, nunca em `date_last_updated` ou na chegada do webhook. Essa data é obrigatória na aprovação e deve ser cronologicamente compatível com o pedido, a atualização do provedor e o relógio do servidor. Duplicados não estendem prazo; atualização antiga não ressuscita reembolso/contestação. Tentativas recusadas anteriores são separadas de uma tentativa posterior aprovada. Um segundo pagamento aprovado para pedido já pago exige revisão, sem segundo termo automático. Reembolso parcial suspende conservadoramente o termo pago para revisão, preservando matrícula gratuita válida.

Configure no Mercado Pago o evento **Pagamentos / payment** para `https://DOMINIO/api/webhooks/mercadopago`, separando teste e produção. Não usar IPN sem assinatura. Reembolsos e contestações atualizados no pagamento são recuperados pela consulta/reconciliação; alertas de reclamações e chargebacks também devem ser acompanhados no painel do provedor. Reembolso administrativo é feito inicialmente no painel oficial do Mercado Pago conforme a política aprovada.

Agende `scheduled()` a cada 30 minutos. `claim_reconciliation_orders` rotaciona até cinco pedidos, inclusive aprovações antigas, consultando até duas tentativas por pedido para manter a execução abaixo do orçamento de subrequests do Workers Free. Mais de duas tentativas gera alerta de revisão; processe o caso no painel do provedor ou aumente a rotina após avaliar plano e custos. Com 70 pedidos, uma rodada completa pode levar sete horas; webhooks são o caminho imediato e esta é a recuperação de falhas. Monitorar `payment_reconciliation_failed`, `multiple_payment_attempts_need_review`, falhas de e-mail, consumo e disponibilidade do Supabase. Se `failed>0` no painel, investigar antes de conceder acesso manualmente.

## Verificação executada e pendências de homologação

`node --experimental-strip-types --test tests/api.test.ts`: **34 testes locais passaram**. Cobrem cadastro sem acesso, verificação, bloqueio, concessões independentes, cancelamento/reativação, isolamento de favoritos, MFA servidor, origem, senha exata, cookies, tokens Bunny expirados, assinatura TUS, validação de arquivo, upload/publicação aguardando provedor, duração exata e excesso sobre 180 segundos, rotas antigas de materiais removidas, reprodução sem materiais, contatos informados, preço confiável no checkout, HMAC/replay, webhook repetido, pagamento incompatível, data original de aprovação, recuperação de tentativa recusada seguida de aprovada, retorno sem concessão e três requisições simultâneas. `tests/database.test.ts` inclui a migração incremental com preservação de dados e a restrição de publicação. O TypeScript do servidor passou em checagem estrita com DOM/Web APIs.

Esses testes usam respostas simuladas dos fornecedores. Eles não comprovam entregabilidade de SMTP, a cobrança real, CDN no Brasil, expiração efetiva no Bunny, qualidade de vídeo, processamento de upload real ou capacidade sob carga real. Esses pontos precisam de ensaio com contas de homologação e três navegadores/usuários reais antes do lançamento. Os testes transacionais SQL e RLS estão em `tests/database.test.ts`.

## Documentação oficial consultada

- [Bunny — TUS e assinatura de upload](https://bunny.net/docs/stream/tus-resumable-uploads)
- [Bunny — token de embed](https://bunny.net/docs/stream/token-authentication)
- [Bunny — duas camadas de proteção](https://bunny.net/docs/stream/security)
- [Bunny — SDK oficial e ciclo da consulta de vídeo](https://github.com/BunnyWay/bunny-stream-android/blob/main/docs/guides/manage-videos.md)
- [Mercado Pago — assinatura e consulta de Webhooks](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks)
- [Mercado Pago — esquema oficial de HMAC](https://github.com/mercadopago/openapi/blob/main/schemas/webhooks.yaml)
- [Supabase — MFA](https://supabase.com/docs/guides/auth/auth-mfa)
- [Supabase — templates e consumo de links por scanners](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase — materiais com URLs temporárias](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl)
