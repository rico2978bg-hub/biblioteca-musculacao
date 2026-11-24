import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterVideos, normalize, type Video } from '../src/catalog.ts';

const videos: Video[] = [
  {
    id: 'hip-thrust',
    title: 'Elevação pélvica com controle',
    exercise: 'Extensão de quadril no banco',
    description: 'Progrida mantendo amplitude segura e alinhamento do tronco.',
    duration_seconds: 180,
    level: 'Iniciante',
    muscles: ['Glúteos'],
    categories: ['Execução'],
    equipment: ['Barra'],
    keywords: ['progressão', 'quadril'],
    thumbnail_url: '',
  },
  {
    id: 'stiff',
    title: 'Stiff: aprenda a dobradiça',
    exercise: 'Stiff com halteres',
    description: 'Técnica de força para o posterior de coxa, sem compensação lombar.',
    duration_seconds: 150,
    level: 'Intermediário',
    muscles: ['Posterior de coxa', 'Glúteos'],
    categories: ['Execução'],
    equipment: ['Halteres'],
    keywords: ['cadeia posterior', 'dobradiça'],
    thumbnail_url: '',
  },
  {
    id: 'drop-set',
    title: 'Drop set: organize a intensidade',
    exercise: 'Rosca com redução de carga',
    description: 'Metodologia avançada para o treino de braços.',
    duration_seconds: 210,
    level: 'Avançado',
    muscles: ['Bíceps'],
    categories: ['Drop set'],
    equipment: ['Halteres'],
    keywords: ['densidade', 'redução'],
    thumbnail_url: '',
  },
];

const ids = (query: string, filters: Parameters<typeof filterVideos>[2] = {}) =>
  filterVideos(videos, query, filters).map(video => video.id);

test('normaliza acentos, cedilha e diferenças de caixa em português', () => {
  assert.equal(normalize('GLÚTEOS, Execução e BíCEPS'), 'gluteos, execucao e biceps');
});

test('encontra o título com caixa diferente e sem acentos', () => {
  assert.deepEqual(ids('ELEVACAO PELVICA'), ['hip-thrust']);
});

test('pesquisa o nome do exercício mesmo fora do título', () => {
  assert.deepEqual(ids('EXTENSAO banco'), ['hip-thrust']);
});

test('pesquisa termos exclusivos da descrição', () => {
  assert.deepEqual(ids('amplitude segura'), ['hip-thrust']);
});

test('pesquisa uma palavra-chave sem exigir ocorrência em título ou descrição', () => {
  assert.deepEqual(ids('DENSIDADE'), ['drop-set']);
});

test('combina todas as palavras da consulta mesmo distribuídas entre os campos', () => {
  assert.deepEqual(ids('pelvica progressao alinhamento'), ['hip-thrust']);
});

test('aceita espaços extras e palavras em ordem diferente', () => {
  assert.deepEqual(ids('  COXA   posterior  '), ['stiff']);
});

test('consulta vazia conserva os resultados disponíveis', () => {
  assert.deepEqual(ids(' \t\n '), ['hip-thrust', 'stiff', 'drop-set']);
});

test('dificuldade filtra sem precisar de texto de busca', () => {
  assert.deepEqual(ids('', { level: 'Avançado' }), ['drop-set']);
});

test('combina busca, dificuldade, grupo, categoria e equipamento', () => {
  assert.deepEqual(ids('cadeia posterior', {
    level: 'Intermediário', muscle: 'Glúteos', category: 'Execução', equipment: 'Halteres',
  }), ['stiff']);
});

test('filtros incompatíveis não ampliam o resultado por união', () => {
  assert.deepEqual(ids('gluteos', { muscle: 'Glúteos', equipment: 'Máquina' }), []);
});

test('categoria e equipamento são combináveis e a consulta exige todas as palavras', () => {
  assert.deepEqual(ids('reducao intensidade', { category: 'Drop set', equipment: 'Halteres' }), ['drop-set']);
  assert.deepEqual(ids('reducao agachamento', { category: 'Drop set', equipment: 'Halteres' }), []);
});
