# Minhas Finanças

Site de controle de receitas e despesas. Os dados ficam numa planilha **"Minhas Finanças"** no Google Drive de cada usuário — o site não tem servidor nem banco de dados próprio.

- Endereço: https://rafael-ferreoli.github.io/financas/
- Demonstração (dados fictícios): https://rafael-ferreoli.github.io/financas/?demo

## Arquivos
- `index.html` – estrutura da página
- `style.css` – visual (claro/escuro automático)
- `app.js` – lógica, login Google e leitura/gravação na planilha
- `config.js` – Client ID do Google (nunca colocar a chave secreta aqui)

## Planilha
- Aba `Lancamentos`: ID | Data | Tipo | Descricao | Categoria | Valor | CriadoEm
- Aba `Categorias`: Nome | Tipo | Cor | Icone
- Aba `Cartoes` e `Fixas`: cartões e lançamentos fixos
- Backups automáticos diários ficam na pasta oculta do app no Drive (appDataFolder)
Não renomeie as abas nem a coluna A (ID).
