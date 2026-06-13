import { html, escapeHtml, formatJson } from '../utils';
import { card, badge, button, select, alert, emptyState } from '../components';

export interface FilterTesterPageData {
  resources: string[];
}

export const filterTesterPage = (data: FilterTesterPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Filter Tester</h1>
    <p class="page-desc">Test RSQL filter expressions against your data</p>
  </div>

  ${card({
    title: 'Filter Expression',
  }, html`
    <div style="display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; gap: 12px;">
        ${select({
          name: 'resource',
          placeholder: 'Select resource...',
          options: data.resources.map(r => ({ value: r, label: r })),
          class: 'resource-select',
        })}
      </div>

      <div>
        <label class="form-label">Filter Expression</label>
        <input type="text" class="input input-mono form-input filter-input" name="filter"
               placeholder='status=="active";createdAt=gt=2024-01-01'
               style="font-size: 14px;">
        <div id="imp-scope-badge" hidden
             style="font-size:12px;color:#c2410c;font-family:var(--font-mono,monospace);margin-top:6px;font-weight:600;"></div>
      </div>

      <div style="display: flex; gap: 8px;">
        ${button('Test Filter', {
          variant: 'primary',
          hxPost: '/__covara/ui/filter/test',
          hxTarget: '#filter-result',
          hxInclude: '[name="resource"],[name="filter"]',
        })}
        ${button('Parse Only', {
          variant: 'secondary',
          hxPost: '/__covara/ui/filter/parse',
          hxTarget: '#filter-result',
          hxInclude: '[name="filter"]',
        })}
      </div>
    </div>
  `)}

  <div style="margin-top: 16px;">
    ${filterSyntaxHelp()}
  </div>

  <div id="filter-result" style="margin-top: 16px;"></div>

  <script>
    (function () {
      function upd() {
        var sel = document.querySelector('[name="resource"]');
        if (window.Covara) Covara.updateScopeBadge('imp-scope-badge', sel && sel.value, 'read');
      }
      var sel = document.querySelector('[name="resource"]');
      if (sel) sel.addEventListener('change', upd);
      document.addEventListener('covara:impersonation', upd);
      upd();
    })();
  </script>
`;

const filterSyntaxHelp = (): string => card({
  title: 'Filter Syntax Reference',
}, html`
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
    <div>
      <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Comparison Operators</h4>
      <table class="table table-mono" style="font-size: 11px;">
        <tbody>
          <tr><td>==</td><td>Equal</td><td>status=="active"</td></tr>
          <tr><td>!=</td><td>Not equal</td><td>status!="deleted"</td></tr>
          <tr><td>=gt=, &gt;</td><td>Greater than</td><td>age=gt=18</td></tr>
          <tr><td>=ge=, &gt;=</td><td>Greater or equal</td><td>price&gt;=100</td></tr>
          <tr><td>=lt=, &lt;</td><td>Less than</td><td>count&lt;10</td></tr>
          <tr><td>=le=, &lt;=</td><td>Less or equal</td><td>score&lt;=100</td></tr>
          <tr><td>=in=</td><td>In set</td><td>status=in=(a,b,c)</td></tr>
          <tr><td>=out=</td><td>Not in set</td><td>type=out=(x,y)</td></tr>
        </tbody>
      </table>

      <h4 style="font-size: 12px; color: var(--text-2); margin: 16px 0 8px;">Pattern Matching</h4>
      <table class="table table-mono" style="font-size: 11px;">
        <tbody>
          <tr><td>%=</td><td>LIKE</td><td>name%="John%"</td></tr>
          <tr><td>=contains=</td><td>Contains</td><td>desc=contains="test"</td></tr>
          <tr><td>=startswith=</td><td>Starts with</td><td>name=startswith="A"</td></tr>
          <tr><td>=endswith=</td><td>Ends with</td><td>file=endswith=".ts"</td></tr>
          <tr><td>=icontains=</td><td>Contains (case-insensitive)</td><td>name=icontains="john"</td></tr>
        </tbody>
      </table>
    </div>

    <div>
      <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Special Operators</h4>
      <table class="table table-mono" style="font-size: 11px;">
        <tbody>
          <tr><td>=isnull=</td><td>Is null</td><td>deletedAt=isnull=true</td></tr>
          <tr><td>=isempty=</td><td>Is null or empty</td><td>notes=isempty=true</td></tr>
          <tr><td>=between=</td><td>Range</td><td>age=between=(18,65)</td></tr>
          <tr><td>=regex=</td><td>Regex match</td><td>email=regex="@test\\.com$"</td></tr>
          <tr><td>=length=</td><td>String length</td><td>code=length=6</td></tr>
          <tr><td>==true</td><td>Boolean true</td><td>active==true</td></tr>
          <tr><td>==false</td><td>Boolean false</td><td>deleted==false</td></tr>
        </tbody>
      </table>

      <h4 style="font-size: 12px; color: var(--text-2); margin: 16px 0 8px;">Combinators</h4>
      <table class="table table-mono" style="font-size: 11px;">
        <tbody>
          <tr><td>;</td><td>AND</td><td>a==1;b==2</td></tr>
          <tr><td>,</td><td>OR</td><td>a==1,b==2</td></tr>
          <tr><td>()</td><td>Grouping</td><td>(a==1,b==2);c==3</td></tr>
        </tbody>
      </table>
    </div>
  </div>
`);

export interface FilterParseResultData {
  filter: string;
  ast?: unknown;
  error?: string;
}

export const filterParseResult = (data: FilterParseResultData): string => html`
  ${data.error ? html`
    ${alert('Parse Error: ' + data.error, 'error')}
    <div style="margin-top: 12px;">
      <div class="code-inline" style="display: block; padding: 12px; background: var(--bg-2);">
        ${escapeHtml(data.filter)}
      </div>
    </div>
  ` : html`
    ${card({
      title: 'Parsed AST',
      headerRight: badge('\u2713 Valid', 'success'),
    }, html`
      <div class="code" style="max-height: 400px; overflow-y: auto;">
        ${escapeHtml(formatJson(data.ast))}
      </div>
    `)}
  `}
`;

export interface FilterTestResultData {
  filter: string;
  resource: string;
  matchCount: number;
  totalCount: number;
  matches: unknown[];
  executionTime: number;
  error?: string;
}

export const filterTestResult = (data: FilterTestResultData): string => html`
  ${data.error ? html`
    ${alert('Filter Error: ' + data.error, 'error')}
  ` : html`
    ${card({
      title: 'Results',
      headerRight: html`
        <div style="display: flex; gap: 8px; align-items: center;">
          ${badge(data.matchCount + '/' + data.totalCount + ' matched', data.matchCount > 0 ? 'success' : 'neutral')}
          ${badge(data.executionTime + 'ms', 'info')}
        </div>
      `,
      flush: true,
    }, html`
      ${data.matches.length > 0 ? html`
        <div style="max-height: 400px; overflow-y: auto;">
          ${data.matches.map((match, i) => html`
            <details class="list-item" style="display: block; cursor: pointer;">
              <summary style="padding: 12px; display: flex; align-items: center; gap: 8px;">
                ${badge('#' + (i + 1), 'neutral')}
                <span class="code-inline" style="flex: 1; overflow: hidden; text-overflow: ellipsis;">
                  ${escapeHtml(JSON.stringify(match).slice(0, 100))}...
                </span>
              </summary>
              <div class="code" style="margin: 0 12px 12px; font-size: 11px;">
                ${escapeHtml(formatJson(match))}
              </div>
            </details>
          `).join('')}
        </div>
      ` : emptyState('\u2205', 'No matches', 'The filter did not match any records')}
    `)}
  `}
`;
