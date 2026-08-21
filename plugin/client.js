return {
  name: 'git-windows-client',
  inject: ['slots'],
  apply(ctx) {
    // Optional theme - read via ctx.get so the plugin still mounts if theme is absent.
    // When present, overrideTokens source is forced to pluginId.packageId by the guard anyway.
    const theme = ctx.get('theme');
    if (theme) {
      try {
        const dispose = theme.overrideTokens('git', {});
        ctx.effect(() => dispose, 'git theme');
      } catch(e) {}
    }
    function GitPanel(props) {
      const [workdir, setWorkdir] = React.useState('');
      const [status, setStatus] = React.useState(null);
      const [log, setLog] = React.useState([]);
      const [diff, setDiff] = React.useState('');
      const [branch, setBranch] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [tab, setTab] = React.useState('status');
      async function call(method, args) {
        try { const res = await host.call(method, args); setError(''); return res; } catch(e) { setError(String(e.message||e)); throw e; }
      }
      async function refresh() {
        if (!workdir) { setError('Enter repo path, e.g. D:\\Projects\\my-repo or C:\\Users\\you\\Projects\\app'); return; }
        setLoading(true); setError('');
        try {
          const [s,l,b] = await Promise.all([call('git-status',{workdir}), call('git-log',{workdir,limit:20}), call('git-branch',{workdir})]);
          setStatus(s); setLog(l.entries||[]); setBranch(b.raw||'');
          try { const d=await call('git-diff',{workdir}); setDiff(d.diff||''); } catch(e){ setDiff(''); }
        } catch(e) {} finally { setLoading(false); }
      }
      const styles = {
        panel: { padding: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: 'var(--dsh-bg, #0f1419)', color: 'var(--dsh-fg, #c5cddb)', borderRadius: '8px', border: '1px solid var(--dsh-border, #252b36)' },
        input: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #2a3342', background: '#0b0e14', color: '#c5cddb', marginBottom: '8px' },
        btn: { padding: '6px 12px', borderRadius: '6px', border: '1px solid #2a3342', background: '#1a2332', color: '#7dc4ff', cursor: 'pointer', marginRight: '6px' },
        btnPrimary: { background: '#0e639c', color: 'white', borderColor: '#0e639c' },
        tabBar: { display: 'flex', gap: '6px', margin: '8px 0', borderBottom: '1px solid #1e2633', paddingBottom: '6px' },
        tab: (active) => ({ padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', background: active ? '#1a2332' : 'transparent', color: active ? '#7dc4ff' : '#8b95a5', border: '1px solid ' + (active ? '#2a3342' : 'transparent') }),
        fileRow: (st) => ({ display: 'flex', gap: '8px', padding: '2px 0', color: st.includes('M') ? '#e5c07b' : st.includes('A') ? '#98c379' : st.includes('D') ? '#e06c75' : st.includes('?') ? '#8b95a5' : '#c5cddb' }),
        code: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#0b0e14', padding: '8px', borderRadius: '6px', border: '1px solid #1e2633', maxHeight: '220px', overflow: 'auto' },
        error: { background: '#2a1a1a', border: '1px solid #5a2a2a', color: '#ff7b7b', padding: '6px 8px', borderRadius: '6px', marginTop: '8px' },
        hint: { color: '#8b95a5', fontSize: '11px', marginTop: '6px' }
      };
      return React.createElement('div', { style: styles.panel },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px', color: '#7dc4ff' } }, 'Git - Windows 11'),
        React.createElement('div', { style: { fontSize: '11px', color: '#8b95a5', marginBottom: '8px' } }, 'Via git.exe + pwsh - native C:\\ paths'),
        React.createElement('input', { style: styles.input, placeholder: 'Repo path e.g. C:\\\\Users\\\\you\\\\Projects\\\\my-app', value: workdir, onChange: (e)=>setWorkdir(e.target.value), onKeyDown: (e)=>{ if(e.key==='Enter') refresh(); } }),
        React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' } },
          React.createElement('button', { style: Object.assign({}, styles.btn, styles.btnPrimary), onClick: refresh, disabled: loading }, loading ? 'Loading...' : 'Refresh'),
          React.createElement('button', { style: styles.btn, onClick: ()=>{ setWorkdir('C:\\\\Users\\\\you\\\\Projects\\\\my-app'); } }, 'Harness'),
          React.createElement('button', { style: styles.btn, onClick: ()=>{ if(status&&status.toplevel){ setWorkdir(status.toplevel);} } }, 'Toplevel'),
          React.createElement('button', { style: styles.btn, onClick: ()=>{ setStatus(null); setLog([]); setDiff(''); setError(''); } }, 'Clear')
        ),
        error ? React.createElement('div', { style: styles.error }, error) : null,
        status ? React.createElement('div', { style: { marginTop: '8px', padding: '6px 8px', background: '#0b0e14', borderRadius: '6px', border: '1px solid #1e2633' } },
          React.createElement('div', null, React.createElement('b', null, 'Branch: '), status.branch || '(detached)'),
          status.toplevel ? React.createElement('div', { style: { fontSize: '11px', color: '#8b95a5', wordBreak: 'break-all' } }, status.toplevel) : null,
          status.remote ? React.createElement('div', { style: { fontSize: '11px', color: '#8b95a5', whiteSpace: 'pre-wrap' } }, status.remote.split('\n')[0]) : null,
          React.createElement('div', { style: { marginTop: '4px' } }, 'Ahead: '+(status.ahead||0)+'  Behind: '+(status.behind||0)+'  Files: '+(status.files?status.files.length:0))
        ) : null,
        React.createElement('div', { style: styles.tabBar }, ['status','log','diff','branch'].map(t=>React.createElement('div',{key:t, style: styles.tab(tab===t), onClick:()=>setTab(t)}, t))),
        tab==='status' && status ? React.createElement('div', null,
          (!status.files||status.files.length===0) ? React.createElement('div',{style:{color:'#98c379'}},'Working tree clean') :
          status.files.map((f,i)=>React.createElement('div',{key:i, style: styles.fileRow(f.status)}, React.createElement('span',{style:{minWidth:'24px', fontWeight:600}}, f.status), React.createElement('span',{style:{wordBreak:'break-all'}}, f.path))),
          React.createElement('div',{style: styles.hint},'Tip: use git_add / git_commit tools, or pwsh.')
        ) : null,
        tab==='log' ? React.createElement('div',{style:{maxHeight:'260px', overflow:'auto'}},
          log.length===0 ? React.createElement('div',{style:{color:'#8b95a5'}},'No commits - Refresh') :
          log.map(c=>React.createElement('div',{key:c.hash, style:{padding:'4px 0', borderBottom:'1px solid #151b25'}},
            React.createElement('div',{style:{display:'flex', gap:'6px'}}, React.createElement('span',{style:{color:'#e5c07b', fontSize:'11px'}}, c.hash.slice(0,7)), React.createElement('span',{style:{color:'#c5cddb', fontWeight:500}}, c.subject)),
            React.createElement('div',{style:{fontSize:'11px', color:'#8b95a5'}}, c.author+' - '+c.date)
          ))
        ) : null,
        tab==='diff' ? React.createElement('div',null, diff ? React.createElement('pre',{style: styles.code}, diff.slice(0,8000)) : React.createElement('div',{style:{color:'#8b95a5'}},'No diff')) : null,
        tab==='branch' ? React.createElement('pre',{style: styles.code}, branch||'(not loaded)') : null,
        React.createElement('div',{style: styles.hint},'Windows: core.autocrlf=true, credential.helper=manager, schannel. Outside workspace needs sandbox escalation.')
      );
    }
    // tool.view.cordis is a keyed slot owned by ui-cordis; guard binds key:'self' to our Plugin+Package.
    // Per CLIENT_SLOT_API NOTES: declare inject:['slots'] (done above) and wrap in ctx.slots.inject(...) so the
    // registration re-runs if the owner remounts.
    ctx.slots.inject('tool.view.cordis', () => ctx.slots.register({ name: 'tool.view.cordis', key: 'self' }, (props) => React.createElement(GitPanel, props)));
    try { ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'git-win-quick' }, () => React.createElement('div',{style:{padding:'6px 8px', fontSize:'12px', color:'#8b95a5'}}, 'Git Windows: Run card -> Git panel'))); } catch(e) {}
  }
};