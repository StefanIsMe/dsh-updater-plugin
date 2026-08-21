// Windows 11 Git plugin - Host half (fixed)
// Provides git integration via ctx.shell (pwsh on Windows). Handles native C:\ paths,
// pwsh single-quote escaping, sandbox, truncation, timeouts.
// FIX 2026-08-20: helpers moved INSIDE apply(ctx) to close over ctx.shell (was ReferenceError),
// plugin now declares inject:['shell'] so Cordis parks until the shell service exists.

return {
  name: 'git-windows',
  inject: ['shell'],
  apply(ctx) {
    function quoteArg(arg) {
      const s = String(arg);
      if (/^[a-zA-Z0-9_\-./:@]+$/.test(s)) return s;
      return "'" + s.replace(/'/g, "''") + "'";
    }
    function buildGitCmd(args) {
      return "git " + args.map(quoteArg).join(" ");
    }
    async function runGit(args, workdir, opts) {
      const shell = ctx.shell;
      if (!shell) throw new Error('shell service not available - host must provide ctx.shell (pwsh on Windows)');
      const command = buildGitCmd(args);
      const timeoutMs = (opts && opts.timeoutMs) || 30000;
      const stdoutMaxBytes = 300000;
      const spec = shell.resolve(workdir ? { command, workdir, timeoutMs, stdoutMaxBytes } : { command, timeoutMs, stdoutMaxBytes });
      const result = await shell.run(spec);
      if (result.sandbox && result.sandbox.denied) {
        throw new Error('[sandbox: file access denied under ' + result.sandbox.mode + ' mode] Git tried to access ' + (workdir || spec.workdir) + '. Retry with sandbox_permissions or move repo inside workspace.');
      }
      if (result.stdout.truncated) console.warn('[git] stdout truncated, spill at ' + (result.stdout.spillPath || 'unknown'));
      if (result.exitCode !== 0) {
        const msg = (result.stderr.text || result.stdout.text || 'git exited ' + result.exitCode).trim();
        throw new Error(msg);
      }
      return result.stdout.text;
    }
    function parseStatus(porcelain) {
      const lines = porcelain.split('\n');
      let branch = '';
      let ahead = 0, behind = 0;
      const files = [];
      for (const line of lines) {
        if (line.startsWith('## ')) {
          branch = line.slice(3);
          const m = branch.match(/\[ahead (\d+)(?:, behind (\d+))?\]/);
          if (m) { ahead = parseInt(m[1]||'0',10); behind = parseInt(m[2]||'0',10); }
          branch = branch.split('...')[0].split(' ')[0];
        } else if (line.length >= 3) {
          const x = line[0], y = line[1];
          const path = line.slice(3);
          const status = (x+y).trim() || 'untracked';
          files.push({ x, y, status, path });
        }
      }
      return { branch: branch || 'unknown', ahead, behind, files };
    }

    harness.handle('git-status', async (args) => {
      const workdir = args && args.workdir ? String(args.workdir) : undefined;
      const porcelain = await runGit(['status', '--porcelain=v1', '--branch'], workdir);
      const parsed = parseStatus(porcelain);
      let toplevel = '';
      try { toplevel = (await runGit(['rev-parse', '--show-toplevel'], workdir)).trim(); } catch(e) { toplevel = workdir || ''; }
      let currentBranch = parsed.branch;
      try { currentBranch = (await runGit(['branch', '--show-current'], workdir)).trim() || currentBranch; } catch(e) {}
      let remote = '';
      try { remote = (await runGit(['remote', '-v'], workdir)).trim(); } catch(e) {}
      return { toplevel, branch: currentBranch, porcelain, files: parsed.files, ahead: parsed.ahead, behind: parsed.behind, remote };
    });
    harness.handle('git-log', async (args) => {
      const workdir = args && args.workdir ? String(args.workdir) : undefined;
      const limit = args && args.limit ? Math.min(100, Math.max(1, parseInt(args.limit,10)||20)) : 20;
      const raw = await runGit(['log', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e', '--date=iso', '-n', String(limit)], workdir);
      const entries = raw.split('\x1e').filter(Boolean).map(s => {
        const p = s.split('\x1f');
        return { hash: p[0], author: p[1], email: p[2], date: p[3], subject: p[4] };
      });
      return { entries, raw };
    });
    harness.handle('git-diff', async (args) => {
      const workdir = args && args.workdir ? String(args.workdir) : undefined;
      const staged = args && args.staged;
      const file = args && args.file ? String(args.file) : undefined;
      const a = ['diff'];
      if (staged) a.push('--staged');
      if (file) a.push('--', file);
      const diff = await runGit(a, workdir);
      return { diff };
    });
    harness.handle('git-branch', async (args) => {
      const workdir = args && args.workdir ? String(args.workdir) : undefined;
      const all = args && args.all;
      const raw = await runGit(all ? ['branch', '-a'] : ['branch'], workdir);
      let current = '';
      try { current = (await runGit(['branch', '--show-current'], workdir)).trim(); } catch(e) {}
      return { raw, current };
    });
    harness.handle('git-show', async (args) => {
      const workdir = args && args.workdir ? String(args.workdir) : undefined;
      const ref = args && args.ref ? String(args.ref) : 'HEAD';
      const out = await runGit(['show', '--stat', ref], workdir);
      return { out };
    });

    harness.registerTool(ctx, harness.defineTool({
      name: 'git_status',
      description: 'Run git status on Windows (pwsh + git.exe). Returns branch, porcelain, file list, toplevel. Pass workdir as native Windows path like D:\\Projects\\my-repo when repo is outside harness workspace.',
      parameters: {
        workdir: { type: 'string', description: 'Native Windows path to repo (e.g. C:\\Users\\you\\Projects\\app). Omit to use harness workspace root.' },
        short: { type: 'boolean', description: 'If true, also include git status --short raw' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = args.workdir ? String(args.workdir) : undefined;
        const porcelain = await runGit(['status', '--porcelain=v1', '--branch'], wd);
        const parsed = parseStatus(porcelain);
        let toplevel = '';
        try { toplevel = (await runGit(['rev-parse', '--show-toplevel'], wd)).trim(); } catch(e) {}
        return { toplevel, branch: parsed.branch, ahead: parsed.ahead, behind: parsed.behind, files: parsed.files, porcelain };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_log',
      description: 'Show git log on Windows with hash/author/date/subject. Safe %x1f/%x1e separators.',
      parameters: {
        workdir: { type: 'string', description: 'Windows repo path' },
        limit: { type: 'number', description: 'Number of commits 1-100 default 20' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = args.workdir ? String(args.workdir) : undefined;
        const lim = args.limit ? Math.min(100, Math.max(1, parseInt(args.limit,10)||20)) : 20;
        const raw = await runGit(['log', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e', '--date=iso', '-n', String(lim)], wd);
        const entries = raw.split('\x1e').filter(Boolean).map(s => {
          const p = s.split('\x1f');
          return { hash: p[0], hashShort: p[0].slice(0,7), author: p[1], email: p[2], date: p[3], subject: p[4] };
        });
        return { count: entries.length, entries };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_diff',
      description: 'Show git diff on Windows. staged:true for --staged. file for single-file diff.',
      parameters: {
        workdir: { type: 'string', description: 'Windows repo path' },
        staged: { type: 'boolean', description: 'Show staged diff' },
        file: { type: 'string', description: 'Single file path relative to repo' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: value.diff || '(no diff)' }]; } },
      async execute(args) {
        const wd = args.workdir ? String(args.workdir) : undefined;
        const a = ['diff'];
        if (args.staged) a.push('--staged');
        if (args.file) a.push('--', String(args.file));
        const diff = await runGit(a, wd);
        return { diff };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_branch',
      description: 'List branches on Windows (git branch -a). all:false for local only.',
      parameters: {
        workdir: { type: 'string', description: 'Windows repo path' },
        all: { type: 'boolean', description: 'Include remotes default true' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: value.raw }]; } },
      async execute(args) {
        const wd = args.workdir ? String(args.workdir) : undefined;
        const useAll = args.all !== false;
        const raw = await runGit(useAll ? ['branch', '-a'] : ['branch'], wd);
        let current = '';
        try { current = (await runGit(['branch', '--show-current'], wd)).trim(); } catch(e) {}
        return { raw, current };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_add',
      description: 'Stage files on Windows (git add). files: space-separated or "." for all. force:true for ignored.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows repo path' },
        files: { type: 'string', required: true, description: 'Files to add e.g. "src\\\\index.ts" or "."' },
        force: { type: 'boolean', description: 'Add ignored files (-f)' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        const files = String(args.files).trim();
        if (!files) throw new Error('files required');
        const parts = files === '.' ? ['.'] : files.split(/\s+/);
        const a = ['add'];
        if (args.force) a.push('-f');
        a.push(...parts);
        await runGit(a, wd);
        const after = await runGit(['status', '--porcelain=v1', '--branch'], wd);
        return { ok: true, added: files, status: after };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_commit',
      description: 'Commit on Windows (git commit -m). Stages must be added first via git_add unless allowEmpty:true.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows repo path' },
        message: { type: 'string', required: true, description: 'Commit message' },
        allowEmpty: { type: 'boolean', description: 'Allow empty commit' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        const msg = String(args.message).trim();
        if (!msg) throw new Error('message required');
        const a = ['commit', '-m', msg];
        if (args.allowEmpty) a.push('--allow-empty');
        const out = await runGit(a, wd);
        let hash = '';
        try { hash = (await runGit(['rev-parse', 'HEAD'], wd)).trim(); } catch(e) {}
        return { ok: true, hash, output: out };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_checkout',
      description: 'Checkout/switch branch on Windows. create:true for checkout -b.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows repo path' },
        branch: { type: 'string', required: true, description: 'Branch name' },
        create: { type: 'boolean', description: 'Create new branch' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        const br = String(args.branch).trim();
        if (!br) throw new Error('branch required');
        const a = args.create ? ['checkout', '-b', br] : ['checkout', br];
        const out = await runGit(a, wd);
        return { ok: true, branch: br, output: out };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_push',
      description: 'Push to remote on Windows (git push). Uses Windows Credential Manager. Timeout 60s.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows repo path' },
        remote: { type: 'string', description: 'Remote name default origin' },
        branch: { type: 'string', description: 'Branch to push' },
        force: { type: 'boolean', description: 'Force push' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        const remote = args.remote ? String(args.remote) : 'origin';
        const a = ['push'];
        if (args.force) a.push('--force');
        a.push(remote);
        if (args.branch) a.push(String(args.branch));
        const out = await runGit(a, wd, { timeoutMs: 60000 });
        return { ok: true, output: out };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_pull',
      description: 'Pull from remote on Windows (git pull). Timeout 60s.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows repo path' },
        remote: { type: 'string', description: 'Remote default origin' },
        branch: { type: 'string', description: 'Branch to pull' },
        rebase: { type: 'boolean', description: 'Use --rebase' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        const a = ['pull'];
        if (args.rebase) a.push('--rebase');
        if (args.remote) { a.push(String(args.remote)); if (args.branch) a.push(String(args.branch)); }
        const out = await runGit(a, wd, { timeoutMs: 60000 });
        return { ok: true, output: out };
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_stash',
      description: 'Stash on Windows: push/list/pop. push needs message.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows repo path' },
        action: { type: 'string', required: true, description: 'push, list, or pop' },
        message: { type: 'string', description: 'Stash message for push' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        const act = String(args.action);
        if (act === 'push') {
          const a = ['stash', 'push', '-m', args.message ? String(args.message) : 'dsh stash'];
          const out = await runGit(a, wd);
          return { ok: true, action: 'push', output: out };
        } else if (act === 'list') {
          const out = await runGit(['stash', 'list'], wd);
          return { ok: true, action: 'list', output: out };
        } else if (act === 'pop') {
          const out = await runGit(['stash', 'pop'], wd);
          return { ok: true, action: 'pop', output: out };
        } else throw new Error('action must be push, list, or pop');
      }
    }));
    harness.registerTool(ctx, harness.defineTool({
      name: 'git_init',
      description: 'Init or clone repo on Windows. init creates repo at workdir. cloneUrl clones into workdir parent.',
      parameters: {
        workdir: { type: 'string', required: true, description: 'Windows path: for init the repo folder; for clone the parent folder' },
        cloneUrl: { type: 'string', description: 'If set, clone this URL' },
        branch: { type: 'string', description: 'Clone branch with -b' }
      },
      output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; } },
      async execute(args) {
        const wd = String(args.workdir);
        if (args.cloneUrl) {
          const a = ['clone'];
          if (args.branch) a.push('-b', String(args.branch));
          a.push(String(args.cloneUrl));
          const out = await runGit(a, wd);
          return { ok: true, mode: 'clone', output: out };
        } else {
          const out = await runGit(['init'], wd);
          return { ok: true, mode: 'init', output: out };
        }
      }
    }));
    console.log('[git-windows] host ready - 11 tools, pwsh, C:\\ paths, sandbox-aware');
  }
};