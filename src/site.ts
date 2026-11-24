export const business = {
  name: 'Biblioteca de Musculação', teacher: 'Professor',
  telephone: '+55 11 90000-0000', telephoneLink: '+5511900000000',
  instagram: 'https://www.instagram.com/seu_perfil/',
  whatsapp: 'https://wa.me/5511900000000',
};

export const pages = {
  inicio: {path:'/',title:'Biblioteca de Musculação | Técnicas com o Professor',description:'Entenda cada movimento com o Professor. Conheça a biblioteca de vídeos curtos de musculação, do iniciante ao avançado, e as condições de acesso.',heading:'Menos dúvida. Mais resultado.',public:true},
  sobre: {path:'/sobre',title:'Sobre o Professor e a plataforma | Biblioteca de Musculação',description:'Conheça o Professor, professor responsável pelos vídeos da Biblioteca de Musculação, a proposta da plataforma e seus canais oficiais de contato.',heading:'Musculação com mais clareza.',public:true},
  assinatura: {path:'/assinatura',title:'Condições de acesso | Biblioteca de Musculação',description:'Saiba como funciona o acesso à biblioteca do Professor por plano pago ou matrícula gratuita concedida pelo professor. Consulte as condições disponíveis.',heading:'Mais conhecimento. Em cada treino.',public:true},
  biblioteca: {path:'/tecnicas',title:'Biblioteca de técnicas | Biblioteca de Musculação',description:'Encontre demonstrações de exercícios e técnicas de musculação por grupo muscular, dificuldade, metodologia e equipamento.',heading:'Explore. Aprenda. Evolua.',public:false},
  inicial: {path:'/tecnicas/iniciante',title:'Técnicas para iniciantes | Biblioteca de Musculação',description:'Construa sua base com demonstrações de exercícios de musculação para iniciantes na biblioteca do Professor.',heading:'Construa uma base forte.',public:false},
  intermediario: {path:'/tecnicas/intermediarias',title:'Técnicas intermediárias | Biblioteca de Musculação',description:'Explore técnicas intermediárias de musculação com o Professor e aprofunde seu entendimento da execução dos exercícios.',heading:'O próximo nível começa aqui.',public:false},
  maxima: {path:'/tecnicas/avancadas',title:'Técnicas avançadas | Biblioteca de Musculação',description:'Consulte técnicas avançadas e metodologias de musculação com foco na execução e na intensidade consciente.',heading:'Intensidade com consciência.',public:false},
  lista: {path:'/minha-lista',title:'Minha lista de técnicas | Biblioteca de Musculação',description:'Acesse os vídeos que você salvou na sua conta da Biblioteca de Musculação.',heading:'Minha lista',public:false},
  conta: {path:'/minha-conta',title:'Minha conta | Biblioteca de Musculação',description:'Consulte sua conta, a situação do acesso e sua assinatura na Biblioteca de Musculação.',heading:'Minha conta',public:false},
  admin: {path:'/administracao',title:'Administração | Biblioteca de Musculação',description:'Painel de administração de vídeos, alunos e configurações da Biblioteca de Musculação. Acesso restrito.',heading:'Área administrativa',public:false},
  confirm: {path:'/confirmar-email',title:'Confirmação de acesso | Biblioteca de Musculação',description:'Confirme seu e-mail ou defina sua senha usando o link temporário enviado pela Biblioteca de Musculação.',heading:'Confirme seu acesso.',public:false},
  privacidade: {path:'/privacidade',title:'Privacidade e dados pessoais | Biblioteca de Musculação',description:'Consulte as informações de privacidade e tratamento de dados pessoais da Biblioteca de Musculação.',heading:'Privacidade',public:false},
  termos: {path:'/termos',title:'Termos de uso | Biblioteca de Musculação',description:'Leia as condições de uso da conta e dos conteúdos educativos da Biblioteca de Musculação.',heading:'Termos de uso',public:false},
  cancelamento: {path:'/cancelamento',title:'Cancelamento e reembolso | Biblioteca de Musculação',description:'Consulte as condições de cancelamento e reembolso e a diferença entre matrícula gratuita e acesso por pagamento.',heading:'Cancelamento e reembolso',public:false},
  'nao-encontrada': {path:'/pagina-nao-encontrada',title:'Página não encontrada | Biblioteca de Musculação',description:'Esta página não foi encontrada. Volte ao início ou conheça a Biblioteca de Musculação.',heading:'Essa página saiu do treino.',public:false},
} as const;
export type PageId = keyof typeof pages;
export const pagePath = (id:string) => pages[id as PageId]?.path || pages['nao-encontrada'].path;
export const pageFromPath = (path:string):PageId => (Object.keys(pages) as PageId[]).find(id=>pages[id].path===path)||'nao-encontrada';
export const aliases:Record<string,string> = {'/inicio':'/','/biblioteca':'/tecnicas','/conta':'/minha-conta','/lista':'/minha-lista','/admin':'/administracao','/confirm':'/confirmar-email'};
export type SiteRuntime = {origin:string;indexing:boolean;analyticsId:string|null;verification?:string|null};
export function metadata(id:string,runtime:SiteRuntime){const page=pages[id as PageId]||pages['nao-encontrada'];return {...page,canonical:runtime.origin+page.path,robots:runtime.indexing&&page.public?'index, follow':'noindex, follow',image:runtime.origin+'/brand/compartilhar.png'};}

/** Same public copy is used in the initial HTML and in the interactive pages. */
export const publicCopy = {
  home: 'Entenda o movimento. Aperfeiçoe a execução. Descomplique a musculação com o Professor.',
  about: 'A Biblioteca de Musculação é a biblioteca de vídeos do Professor, professor responsável por produzir e organizar as aulas. A proposta é explicar exercícios, técnicas e metodologias com demonstrações de até 3 minutos, do iniciante ao avançado.',
  access: 'O cadastro por si só não libera as aulas. O acesso depende de uma conta habilitada e de uma assinatura paga ou matrícula gratuita válida concedida pelo professor. Preço, periodicidade e políticas comerciais serão definidos antes da abertura das inscrições.',
};
