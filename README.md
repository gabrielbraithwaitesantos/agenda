# Agenda IA

Pequeno app de agenda com assistente conversacional (Groq) e sincronização opcional com Firebase.

Execução local

1. Instale dependências (apenas `serve` usado para dev):

```bash
npm install
npm run dev
```

2. Abra `http://localhost:8000`.

Firebase Hosting

1. Faça login na CLI do Firebase:

```bash
npx firebase-tools login
```

2. Publique o site:

```bash
npm run deploy
```

Se você preferir rodar a CLI sem o script, use:

```bash
npx firebase-tools deploy --only hosting
```

O que tem neste repositório

- `index.html` — entrada da aplicação (contém `firebaseConfig` e pontos do UI como splash, calendário e painel direito).
- `styles.css` — estilos visuais (tema preto/branco/azul).
- `app.js` — lógica do app: CRUD, calendário, integração Groq, import/export, Firestore helpers, aprendizado local.

Funcionalidades principais

- CRUD local de tarefas e calendário mensal.
- Splash inicial com envio rápido para a IA ou opção de pular.
- Exportar tarefas em JSON ou imprimir (Salvar como PDF) via botão "Exportar PDF".
- Importador flexível: aceita JSON, CSV, ou texto livre (tenta extrair tarefas automaticamente).
- Integração com Groq (envio de prompts) para sugerir tarefas e estimativas.
- Persistência opcional no Firebase Firestore (coleções `tasks`, `messages`, `events`, `learning`).
- Aprendizado simples: marcações de conclusão salvam `actualDuration` e geram agregados por categoria e por nome, usados para melhorar estimativas.
- Toggle de privacidade para habilitar/ desabilitar envio de dados de aprendizado (`learning`).

Privacidade e segurança

- Atualmente a chave do Firebase e do Groq estão no cliente (`index.html`) para facilitar testes locais. Para um app público, mova chaves sensíveis para um backend e aplique regras de segurança no Firestore.
- O toggle "Enviar dados para aprendizado" controla se registros anônimos vão para a coleção `learning` no Firestore.

Próximos passos sugeridos

- Implementar servidor para coletar/gerenciar dados e executar agregações com segurança.
- Melhorar matching por similaridade com embeddings para agrupar tarefas semelhantes.
- Adicionar testes e documentação adicional.

---
Feito rapidamente para prototipagem. Se quiser, eu implemento os próximos passos sugeridos automaticamente.