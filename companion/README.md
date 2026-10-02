# Sky companion

A small program that lets your Stars use your own computer, only as far as you
allow. It needs Node 22 or newer and nothing else (no packages).

## Set it up

1. In Sky, open Settings → Your computer and make a pairing code.
2. On the computer:

   ```
   node sky-companion.mjs pair https://your-sky-address CODE
   node sky-companion.mjs allow-folder ~/Documents/Sky
   node sky-companion.mjs allow-command git
   node sky-companion.mjs
   ```

The code works once, for 10 minutes. The program keeps its settings in
`~/.sky-companion.json` (readable only by you).

## What Stars can do

Open a web page in your browser, list a folder, read a text file, write a text
file, and run a program. Nothing is allowed until you add it:

| Command | Allows |
| --- | --- |
| `allow-folder <path>` | That folder and what's inside it (links are followed first, so a link out of it doesn't work) |
| `allow-command <program>` | A program by name, like `git` or `python3`. It runs with no shell, so `;`, `|` and `$()` are just text |
| `allow-open-urls on` | Opening web pages |
| `disallow-folder`, `disallow-command` | Takes one away (it takes effect straight away while the program runs) |

Don't allow a shell (`bash`, `cmd`, `powershell`) or `sudo`: they can run
anything, so the allowlist stops meaning anything. The program warns you.

## Four limits

1. The allowlist above. Only you can change it, here.
2. A visible switch. While it runs, the status line shows **ON** or **OFF**;
   press `o` to switch. There's a matching switch in Sky. Off in either place
   means nothing runs.
3. Every action is an approval in Sky first, whatever the Star's autonomy.
4. By default it asks again here: "Scout wants to read the file … Allow?
   [y/N]". Turn that off with `confirm off`. With no keyboard the answer is no.

## Other commands

`status`, `name <name>`, `unpair`. Sky can also unpair it from the app.

## What isn't built

Controlling the screen (clicking and typing in other programs) isn't built.
Stars use sites through the browser tools instead. On Windows and macOS only the
Linux paths were tested; opening a page uses `xdg-open`, `open` or the Windows
URL handler.
