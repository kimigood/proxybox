'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

const callExec = rpc.declare({
  object: 'file',
  method: 'exec',
  params: ['command', 'params'],
});

async function svc(script, action) {
  try {
    const r = await callExec(script, [action]);
    return (r.code === 0);
  } catch (e) {
    return false;
  }
}

async function isRunning(script) {
  try {
    const r = await callExec(script, ['running']);
    return r.code === 0;
  } catch (e) {
    return false;
  }
}

return view.extend({
  render() {
    const panelUrl = `${location.protocol}//${location.hostname}:3037`;
    return E('div', { class: 'cbi-map' }, [
      E('h2', {}, _('ProxyBox')),
      E('div', { class: 'cbi-map-descr' }, [
        _('Emergency controls. The full panel lives at '),
        E('a', { href: panelUrl, target: '_blank' }, panelUrl),
      ]),
      E('div', { class: 'cbi-section' }, [
        E('h3', {}, _('Core (sing-box)')),
        E('div', { class: 'cbi-value' }, [
          E('label', { class: 'cbi-value-title' }, _('Status')),
          E('div', { class: 'cbi-value-field' }, E('span', { id: 'pb-core-status' }, _('…'))),
        ]),
        E('div', { class: 'cbi-value cbi-value-last' }, [
          E('label', { class: 'cbi-value-title' }, _('Actions')),
          E('div', { class: 'cbi-value-field' }, [
            E('button', {
              class: 'btn cbi-button cbi-button-apply',
              click: () => svc('/etc/init.d/proxybox-core', 'restart').then(refresh),
            }, _('Restart')),
            ' ',
            E('button', {
              class: 'btn cbi-button cbi-button-remove',
              click: () => svc('/etc/init.d/proxybox-core', 'stop').then(refresh),
            }, _('Stop')),
          ]),
        ]),
      ]),
      E('div', { class: 'cbi-section' }, [
        E('h3', {}, _('Panel')),
        E('div', { class: 'cbi-value' }, [
          E('label', { class: 'cbi-value-title' }, _('Status')),
          E('div', { class: 'cbi-value-field' }, E('span', { id: 'pb-panel-status' }, _('…'))),
        ]),
        E('div', { class: 'cbi-value cbi-value-last' }, [
          E('label', { class: 'cbi-value-title' }, _('Actions')),
          E('div', { class: 'cbi-value-field' }, [
            E('button', {
              class: 'btn cbi-button cbi-button-apply',
              click: () => svc('/etc/init.d/proxybox-panel', 'restart').then(refresh),
            }, _('Restart')),
          ]),
        ]),
      ]),
      E('div', { class: 'cbi-section' }, [
        E('h3', {}, _('Emergency')),
        E('p', {}, _('Stop the proxy and return to plain direct connection.')),
        E('button', {
          class: 'btn cbi-button cbi-button-reset',
          click: (ev) => {
            ui.showModal(_('Confirm'), [
              E('p', {}, _('Stop ProxyBox core and restore direct connection?')),
              E('div', { class: 'right' }, [
                E('button', { class: 'btn', click: () => ui.hideModal() }, _('Cancel')),
                ' ',
                E('button', {
                  class: 'btn cbi-button cbi-button-remove',
                  click: async () => {
                    ui.hideModal();
                    await svc('/etc/init.d/proxybox-core', 'stop');
                    await svc('/etc/init.d/proxybox-core', 'disable');
                    refresh();
                  },
                }, _('Stop and restore direct')),
              ]),
            ]);
          },
        }, _('Emergency stop & restore direct')),
      ]),
    ]);

    async function refresh() {
      const core = await isRunning('/etc/init.d/proxybox-core');
      const panel = await isRunning('/etc/init.d/proxybox-panel');
      const cs = document.getElementById('pb-core-status');
      const ps = document.getElementById('pb-panel-status');
      if (cs) { cs.textContent = core ? _('Running') : _('Stopped'); cs.style.color = core ? 'green' : 'red'; }
      if (ps) { ps.textContent = panel ? _('Running') : _('Stopped'); ps.style.color = panel ? 'green' : 'red'; }
    }
    poll.add(refresh, 5);
    refresh();
  },
});
