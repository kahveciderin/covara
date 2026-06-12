import { html, escapeHtml, formatRelativeTime, formatJson } from '../utils';
import { card, badge, button, statCard, emptyState, grid } from '../components';

export interface TaskQueueStats {
  pending: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
  dlq: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  priority: number;
  scheduledFor: string;
  payload?: unknown;
}

export interface DLQEntry {
  id: string;
  taskName: string;
  error: string;
  failedAt: string;
  attempts: number;
  payload?: unknown;
}

export interface WorkerInfo {
  id: string;
  status: 'running' | 'paused' | 'stopped';
  processedCount: number;
  failedCount: number;
  currentTask?: string;
}

export interface TasksPageData {
  stats: TaskQueueStats;
  scheduled: ScheduledTask[];
  dlq: DLQEntry[];
  workers: WorkerInfo[];
}

export const tasksPage = (data: TasksPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Task Queue</h1>
    <p class="page-desc">Monitor background tasks and workers</p>
  </div>

  ${grid([
    statCard('Pending', data.stats.pending, data.stats.pending > 100 ? 'warning' : 'info'),
    statCard('Scheduled', data.stats.scheduled, 'neutral'),
    statCard('Running', data.stats.running, 'success'),
    statCard('Failed', data.stats.failed, data.stats.failed > 0 ? 'error' : 'neutral'),
    statCard('DLQ', data.stats.dlq, data.stats.dlq > 0 ? 'error' : 'neutral'),
  ])}

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px;">
    <div>
      ${workersCard(data.workers)}
    </div>
    <div>
      ${scheduledCard(data.scheduled)}
    </div>
  </div>

  <div style="margin-top: 16px;">
    ${dlqCard(data.dlq)}
  </div>
`;

const workersCard = (workers: WorkerInfo[]): string => card({
  title: 'Workers',
  headerRight: badge(workers.length + ' workers', 'neutral'),
}, html`
  ${workers.length > 0 ? html`
    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${workers.map(worker => html`
        <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-2); border-radius: 6px;">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${workerStatusColor(worker.status)};"></div>
          <div style="flex: 1;">
            <div style="font-weight: 500; font-size: 13px;">${escapeHtml(worker.id)}</div>
            <div style="font-size: 12px; color: var(--text-2);">
              ${worker.currentTask ? html`Processing: <span class="code-inline">${escapeHtml(worker.currentTask)}</span>` : 'Idle'}
            </div>
          </div>
          <div style="text-align: right; font-size: 12px;">
            <div style="color: var(--success);">\u2713 ${worker.processedCount}</div>
            <div style="color: var(--error);">\u2717 ${worker.failedCount}</div>
          </div>
          ${workerStatusBadge(worker.status)}
        </div>
      `).join('')}
    </div>
  ` : html`
    <p style="color: var(--text-3); text-align: center; padding: 20px;">No workers registered</p>
  `}
`);

const workerStatusColor = (status: string): string => {
  switch (status) {
    case 'running': return 'var(--success)';
    case 'paused': return 'var(--warning)';
    case 'stopped': return 'var(--error)';
    default: return 'var(--text-3)';
  }
};

const workerStatusBadge = (status: string): string => {
  switch (status) {
    case 'running': return badge('Running', 'success');
    case 'paused': return badge('Paused', 'warning');
    case 'stopped': return badge('Stopped', 'error');
    default: return badge(status, 'neutral');
  }
};

const scheduledCard = (tasks: ScheduledTask[]): string => card({
  title: 'Scheduled Tasks',
  headerRight: badge(tasks.length + ' tasks', 'neutral'),
  flush: true,
}, html`
  ${tasks.length > 0 ? html`
    <div style="max-height: 300px; overflow-y: auto;">
      ${tasks.map(task => html`
        <div class="list-item">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="code-inline">${escapeHtml(task.name)}</span>
              ${priorityBadge(task.priority)}
            </div>
            <div style="font-size: 12px; color: var(--text-2); margin-top: 4px;">
              Scheduled: ${formatRelativeTime(task.scheduledFor)}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  ` : emptyState('\u23F0', 'No scheduled tasks', 'Tasks will appear when scheduled')}
`);

const priorityBadge = (priority: number): string => {
  if (priority <= 25) return badge('P0', 'error');
  if (priority <= 50) return badge('P1', 'warning');
  if (priority <= 75) return badge('P2', 'info');
  return badge('P3', 'neutral');
};

const dlqCard = (entries: DLQEntry[]): string => card({
  title: 'Dead Letter Queue',
  headerRight: html`
    <div style="display: flex; gap: 8px; align-items: center;">
      ${badge(entries.length + ' entries', entries.length > 0 ? 'error' : 'neutral')}
      ${entries.length > 0 ? button('Retry All', {
        variant: 'secondary',
        size: 'sm',
        hxPost: '/__covara/api/tasks/dlq/retry-all',
        hxConfirm: 'Retry all ' + entries.length + ' failed tasks?',
        hxTarget: '#dlq-list',
      }) : ''}
    </div>
  `,
  flush: true,
}, html`
  <div id="dlq-list">
    ${entries.length > 0 ? html`
      <div style="overflow-x: auto;">
        <table class="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Error</th>
              <th>Failed</th>
              <th>Attempts</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(entry => html`
              <tr>
                <td><span class="code-inline">${escapeHtml(entry.taskName)}</span></td>
                <td style="max-width: 300px;">
                  <div style="color: var(--error); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${escapeHtml(entry.error)}
                  </div>
                </td>
                <td style="color: var(--text-2); font-size: 12px; white-space: nowrap;">
                  ${formatRelativeTime(entry.failedAt)}
                </td>
                <td>${badge(entry.attempts + 'x', 'neutral')}</td>
                <td>
                  <div style="display: flex; gap: 4px;">
                    ${button('Retry', {
                      size: 'sm',
                      variant: 'primary',
                      hxPost: '/__covara/api/tasks/dlq/' + entry.id + '/retry',
                      hxTarget: 'closest tr',
                      hxSwap: 'outerHTML',
                    })}
                    ${button('Details', {
                      size: 'sm',
                      variant: 'secondary',
                      hxGet: '/__covara/ui/tasks/dlq/' + entry.id,
                      hxTarget: '#dlq-detail',
                      hxSwap: 'innerHTML',
                    })}
                    ${button('\u2715', {
                      size: 'sm',
                      variant: 'ghost',
                      class: 'btn-danger',
                      hxDelete: '/__covara/api/tasks/dlq/' + entry.id,
                      hxConfirm: 'Remove from DLQ? This cannot be undone.',
                      hxTarget: 'closest tr',
                      hxSwap: 'outerHTML',
                    })}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : emptyState('\u2713', 'No failed tasks', 'Failed tasks will appear here for retry')}
  </div>

  <div id="dlq-detail" style="border-top: 1px solid var(--border);"></div>
`);

export interface DLQDetailData {
  entry: DLQEntry;
}

export const dlqDetail = (data: DLQDetailData): string => html`
  <div style="padding: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h4 style="font-weight: 600;">DLQ Entry Details</h4>
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#dlq-detail',
        hxSwap: 'innerHTML',
      })}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Info</h5>
        <table class="table" style="font-size: 12px;">
          <tr><td style="color: var(--text-2);">ID</td><td class="code-inline">${escapeHtml(data.entry.id)}</td></tr>
          <tr><td style="color: var(--text-2);">Task</td><td>${escapeHtml(data.entry.taskName)}</td></tr>
          <tr><td style="color: var(--text-2);">Attempts</td><td>${data.entry.attempts}</td></tr>
          <tr><td style="color: var(--text-2);">Failed</td><td>${formatRelativeTime(data.entry.failedAt)}</td></tr>
        </table>
      </div>

      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Error</h5>
        <div class="code" style="background: var(--error-bg); color: var(--error); max-height: 100px; overflow-y: auto;">
          ${escapeHtml(data.entry.error)}
        </div>

        ${data.entry.payload ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin: 12px 0 8px;">Payload</h5>
          <div class="code" style="max-height: 150px; overflow-y: auto;">
            ${escapeHtml(formatJson(data.entry.payload))}
          </div>
        ` : ''}
      </div>
    </div>
  </div>
`;
