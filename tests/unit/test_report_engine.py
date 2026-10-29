# -*- coding: utf-8 -*-
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(ROOT, 'python', 'report_engine.py')
PY = r'C:\Users\Aleman\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'


def run_engine(payload):
    p = subprocess.run([PY, ENGINE], input=json.dumps(payload), capture_output=True, text=True, encoding='utf-8', timeout=20)
    try:
        return json.loads(p.stdout)
    except Exception:
        return {'ok': False, 'error': p.stderr or p.stdout}


class TestValidation(unittest.TestCase):
    def test_unknown_component(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [{'type': 'foo'}]}})
        self.assertFalse(r['ok'])

    def test_kpi_requires_column(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [{'type': 'kpi'}]}})
        self.assertFalse(r['ok'])

    def test_valid_report(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [{'type': 'kpi', 'column': 'q', 'agg': 'sum'}]}})
        self.assertTrue(r['ok'])

    def test_too_many_components(self):
        comps = [{'type': 'text', 'text': 'x'} for _ in range(51)]
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': comps}})
        self.assertFalse(r['ok'])


class TestRender(unittest.TestCase):
    DATA = {'columns': ['item', 'qty', 'price'], 'rows': [
        {'item': 'A', 'qty': 10, 'price': 5},
        {'item': 'A', 'qty': 3, 'price': 5},
        {'item': 'B', 'qty': 7, 'price': 2},
        {'item': None, 'qty': None, 'price': 0},
    ]}

    def test_kpi_sum(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'kpi', 'label': 'sum', 'column': 'qty', 'agg': 'sum'}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('20', r['html'])  # 10+3+7 = 20

    def test_kpi_missing_column(self):
        """عمود مفقود ⇒ خطأ صريح لا بطاقة توهم بقيمة."""
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'kpi', 'label': 'x', 'column': 'nope', 'agg': 'sum'}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('comp-error', r['html'])
        self.assertNotIn('kpi-value', r['html'])
        self.assertNotIn('—', r['html'])

    def test_table(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'table', 'columns': ['item', 'qty'], 'limit': 2}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('<table', r['html'])
        self.assertIn('A', r['html'])

    def test_bar_chart(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'bar', 'category': 'item', 'value': 'qty', 'agg': 'sum', 'title': 'chart'}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('<svg', r['html'])
        self.assertIn('rect', r['html'])

    def test_pie_chart(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'pie', 'category': 'item', 'value': 'qty', 'agg': 'sum', 'title': 'pie'}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('<svg', r['html'])
        self.assertIn('<path', r['html'])

    def test_line_chart_needs_two(self):
        payload = {
            'action': 'render',
            'report': {'title': 't', 'components': [
                {'type': 'line', 'category': 'item', 'value': 'qty', 'agg': 'sum', 'title': 'line'}
            ]},
            'data': {'columns': ['item', 'qty'], 'rows': [{'item': 'A', 'qty': 5}]}
        }
        r = run_engine(payload)
        self.assertTrue(r['ok'])
        self.assertIn('لا بيانات كافية', r['html'])

    def test_heading_text(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'heading', 'text': 'H'}, {'type': 'text', 'text': 'T'}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('H', r['html'])
        self.assertIn('T', r['html'])

    def test_kpi_decimals(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'kpi', 'label': 'avg', 'column': 'qty', 'agg': 'avg', 'decimals': 2}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('6.67', r['html'])

    def test_chart_show_title_false(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'bar', 'category': 'item', 'value': 'qty', 'agg': 'sum', 'title': 'HIDDEN', 'showTitle': False}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertNotIn('HIDDEN', r['html'])

    def test_empty_data(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum'}
        ]}, 'data': {'columns': ['qty'], 'rows': []}})
        self.assertTrue(r['ok'])

    def test_invalid_report(self):
        r = run_engine({'action': 'render', 'report': {'components': 'bad'}, 'data': self.DATA})
        self.assertFalse(r['ok'])

    def test_no_eval(self):
        # ensure eval-like strings are not executed
        r = run_engine({'action': 'render', 'report': {'title': 't', 'components': [
            {'type': 'text', 'text': "__import__('os').system('echo pwned')"}
        ]}, 'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('__import__', r['html'])

    def test_standalone_export(self):
        r = run_engine({'action': 'export', 'report': {'title': 'تقرير', 'components': [
            {'type': 'heading', 'text': 'H'}
        ]}, 'data': self.DATA, 'standalone': True})
        self.assertTrue(r['ok'])
        self.assertIn('<!DOCTYPE html>', r['html'])
        self.assertIn("dir='rtl'", r['html'])


class TestDesign(unittest.TestCase):
    """خصائص التصميم: النمط · التخطيط · الشروط · الفاصل — بلا أثر على الأرقام."""

    DATA = {'columns': ['item', 'qty'], 'rows': [
        {'item': 'A', 'qty': 10},
        {'item': 'B', 'qty': 5},
    ]}

    def render(self, comps, data=None):
        return run_engine({'action': 'render', 'report': {'title': 't', 'components': comps},
                           'data': data or self.DATA})

    def test_style_applied(self):
        r = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum',
                          'style': {'bg': '#101a30', 'color': '#ffffff', 'radius': 18, 'padding': 20}}])
        self.assertTrue(r['ok'])
        self.assertIn('#101a30', r['html'])
        self.assertIn('border-radius:18px', r['html'])
        self.assertIn('padding:20px', r['html'])

    def test_unsafe_style_is_ignored(self):
        r = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum',
                          'style': {'bg': 'red; background-image:url(http://x/y)',
                                     'border': 'url(javascript:alert(1))'}}])
        self.assertTrue(r['ok'])
        self.assertNotIn('javascript:', r['html'])
        self.assertNotIn('url(', r['html'])

    def test_grid_placement(self):
        r = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum', 'grid': {'w': 4, 'h': 2}}])
        self.assertTrue(r['ok'])
        self.assertIn('grid-column:span 4', r['html'])

    def test_legacy_component_is_full_width(self):
        r = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum'}])
        self.assertIn('grid-column:span 12', r['html'])

    def test_layout_columns_used(self):
        r = run_engine({'action': 'render', 'report': {'title': 't', 'layout': {'columns': 6, 'gap': 8},
                                                       'components': [{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum'}]},
                        'data': self.DATA})
        self.assertTrue(r['ok'])
        self.assertIn('repeat(6', r['html'])
        self.assertIn('gap:8px', r['html'])

    def test_conditional_formatting_row(self):
        r = self.render([{'type': 'table', 'columns': ['item', 'qty'],
                          'rules': [{'column': 'qty', 'op': '>', 'value': 8, 'bg': '#330000'}]}])
        self.assertTrue(r['ok'])
        self.assertIn('#330000', r['html'])
        self.assertIn('10', r['html'])
        self.assertIn('5', r['html'])

    def test_conditional_formatting_kpi(self):
        r = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum',
                          'rules': [{'column': 'qty', 'op': '>', 'value': 8, 'color': '#fb7185'}]}])
        self.assertTrue(r['ok'])
        self.assertIn('kpi-hit', r['html'])
        self.assertIn('#fb7185', r['html'])
        self.assertIn('15', r['html'])

    def test_divider(self):
        r = self.render([{'type': 'divider'}])
        self.assertTrue(r['ok'])
        self.assertIn('rep-divider', r['html'])

    def test_divider_is_valid(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [{'type': 'divider'}]}})
        self.assertTrue(r['ok'])

    def test_invalid_rule_rejected(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [
            {'type': 'table', 'columns': ['a'], 'rules': [{'column': 'a', 'op': 'DROP'}]}]}})
        self.assertFalse(r['ok'])

    def test_style_does_not_change_numbers(self):
        plain = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum'}])
        styled = self.render([{'type': 'kpi', 'label': 'x', 'column': 'qty', 'agg': 'sum',
                               'style': {'bg': '#123456'}, 'grid': {'w': 3, 'h': 1}}])
        self.assertIn('15', plain['html'])
        self.assertIn('15', styled['html'])




class TestColumnValidation(unittest.TestCase):
    """العمود المفقود ⇒ خطأ واضح: لا استبدال صامت ولا نتيجة مضلِّلة."""

    DATA = {'columns': ['item', 'qty'], 'rows': [
        {'item': 'SECRET_ITEM', 'qty': 987654},
    ]}

    def render(self, comps, data=None):
        return run_engine({'action': 'render', 'report': {'title': 't', 'components': comps},
                           'data': self.DATA if data is None else data})

    def test_valid_report_keeps_working(self):
        r = self.render([
            {'type': 'kpi', 'id': 'e1', 'label': 'المجموع', 'column': 'qty', 'agg': 'sum'},
            {'type': 'table', 'id': 'e2', 'columns': ['item', 'qty']},
            {'type': 'bar', 'id': 'e3', 'title': 'مخطط', 'category': 'item', 'value': 'qty', 'agg': 'sum'},
        ])
        self.assertTrue(r['ok'])
        self.assertEqual(r.get('errors') or [], [])
        self.assertIn('987,654', r['html'])
        self.assertIn('<table', r['html'])
        self.assertIn('<svg', r['html'])
        self.assertNotIn('comp-error', r['html'])
        self.assertNotIn('rep-errors', r['html'])

    def test_table_missing_column_is_not_substituted(self):
        r = self.render([{'type': 'table', 'id': 'e2', 'columns': ['nope']}])
        self.assertTrue(r['ok'])
        self.assertTrue(r['errors'])
        self.assertIn('nope', r['errors'][0]['message'])
        self.assertIn('comp-error', r['html'])
        self.assertNotIn('<table', r['html'])
        self.assertNotIn('<th>item</th>', r['html'])
        self.assertNotIn('<th>qty</th>', r['html'])

    def test_table_partial_missing_column_fails(self):
        r = self.render([{'type': 'table', 'id': 'e2', 'columns': ['item', 'nope']}])
        self.assertTrue(r['errors'])
        self.assertIn('comp-error', r['html'])
        self.assertNotIn('<table', r['html'])
        self.assertNotIn('<th>item</th>', r['html'])

    def test_kpi_missing_column(self):
        r = self.render([{'type': 'kpi', 'id': 'e1', 'label': 'مؤشر', 'column': 'nope', 'agg': 'sum'}])
        self.assertTrue(r['errors'])
        self.assertIn('comp-error', r['html'])
        self.assertNotIn('kpi-value', r['html'])
        self.assertNotIn('—', r['html'])

    def test_chart_missing_column(self):
        r = self.render([{'type': 'bar', 'id': 'e3', 'title': 'مخطط', 'category': 'item', 'value': 'nope', 'agg': 'sum'}])
        self.assertTrue(r['errors'])
        self.assertIn('comp-error', r['html'])
        self.assertNotIn('<svg', r['html'])
        self.assertNotIn('لا قيم رقمية', r['html'])

    def test_error_identifies_component_and_column(self):
        r = self.render([{'type': 'kpi', 'id': 'kpi_7', 'label': 'إجمالي التكلفة', 'column': 'nope', 'agg': 'sum'}])
        msg = r['errors'][0]['message']
        self.assertIn('kpi_7', msg)
        self.assertIn('إجمالي التكلفة', msg)
        self.assertIn('nope', msg)
        self.assertEqual(r['errors'][0]['componentId'], 'kpi_7')

    def test_error_does_not_leak_query_rows_or_secrets(self):
        r = self.render([{'type': 'kpi', 'id': 'e1', 'label': 'x', 'column': 'nope', 'agg': 'sum'}])
        html = r['html']
        low = html.lower()
        for bad in ('select ', ' from ', ' where ', 'password', 'postgres', 'pg_hba', 'config.json', 'secret_item', '987654'):
            self.assertNotIn(bad, low)

    def test_error_isolated_to_failing_component(self):
        r = self.render([
            {'type': 'kpi', 'id': 'ok', 'label': 'سليم', 'column': 'qty', 'agg': 'sum'},
            {'type': 'kpi', 'id': 'bad', 'label': 'خاطئ', 'column': 'nope', 'agg': 'sum'},
        ])
        self.assertTrue(r['ok'])
        self.assertEqual(len(r['errors']), 1)
        self.assertIn('kpi-value', r['html'])
        self.assertIn('comp-error', r['html'])
        self.assertIn('rep-errors', r['html'])

    def test_old_definition_without_optional_fields_still_works(self):
        """تعريف قديم (بلا id/style/grid/rules/source) يبقى صالحًا."""
        r = self.render([
            {'type': 'kpi', 'label': 'مجموع', 'column': 'qty', 'agg': 'sum'},
            {'type': 'table', 'columns': ['item']},
        ])
        self.assertTrue(r['ok'])
        self.assertEqual(r.get('errors') or [], [])
        self.assertIn('987,654', r['html'])
        self.assertNotIn('comp-error', r['html'])

    def test_validate_with_data_detects_missing_column(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [
            {'type': 'kpi', 'label': 'x', 'column': 'nope', 'agg': 'sum'}]},
            'data': {'columns': ['item', 'qty'], 'rows': []}})
        self.assertFalse(r['ok'])
        self.assertIn('nope', r['error'])

    def test_validate_without_data_is_definition_only(self):
        r = run_engine({'action': 'validate', 'report': {'name': 'x', 'components': [
            {'type': 'kpi', 'label': 'x', 'column': 'nope', 'agg': 'sum'}]}})
        self.assertTrue(r['ok'])

    def test_aggregation_and_format_unchanged_for_valid_columns(self):
        r = self.render([{'type': 'kpi', 'label': 'sum', 'column': 'qty', 'agg': 'sum', 'decimals': 2}])
        self.assertIn('987,654.00', r['html'])
        r2 = self.render([{'type': 'table', 'columns': ['item', 'qty'], 'sort': 'qty', 'desc': True, 'decimals': 0}])
        self.assertIn('<th>item</th>', r2['html'])
        self.assertNotIn('comp-error', r2['html'])



class TestReportFilters(unittest.TestCase):
    DATA = {'columns': ['item', 'qty', 'note'], 'rows': [
        {'item': 'A', 'qty': 10, 'note': 'x'},
        {'item': 'B', 'qty': 3, 'note': 'y'},
        {'item': 'C', 'qty': 7, 'note': ''},
    ]}

    def _render(self, report):
        return run_engine({'action': 'render', 'report': report, 'data': self.DATA})

    def test_no_filters_keeps_all_rows(self):
        r = self._render({'title': 't', 'components': [{'type': 'table', 'columns': ['item', 'qty']}]})
        self.assertTrue(r['ok'])
        self.assertEqual(r['rows'], 3)
        self.assertEqual(r.get('filtered', 0), 0)

    def test_numeric_filter(self):
        r = self._render({'title': 't', 'components': [{'type': 'table', 'columns': ['item', 'qty']}],
                          'filters': [{'column': 'qty', 'op': '>', 'value': 5}]})
        self.assertTrue(r['ok'])
        self.assertEqual(r['rows'], 2)
        self.assertEqual(r.get('filtered'), 1)
        self.assertIn('A', r['html'])
        self.assertIn('C', r['html'])

    def test_contains_filter(self):
        r = self._render({'title': 't', 'components': [{'type': 'table', 'columns': ['item']}],
                          'filters': [{'column': 'item', 'op': 'contains', 'value': 'A'}]})
        self.assertEqual(r['rows'], 1)
        self.assertIn('A', r['html'])

    def test_empty_filter(self):
        r = self._render({'title': 't', 'components': [{'type': 'table', 'columns': ['item', 'note']}],
                          'filters': [{'column': 'note', 'op': 'empty'}]})
        self.assertEqual(r['rows'], 1)

    def test_invalid_filter_ignored(self):
        r = self._render({'title': 't', 'components': [{'type': 'table', 'columns': ['item']}],
                          'filters': [{'column': 'item', 'op': 'DROP TABLE', 'value': 'x'}]})
        self.assertTrue(r['ok'])
        self.assertEqual(r['rows'], 3)

    def test_filter_without_column_ignored(self):
        r = self._render({'title': 't', 'components': [{'type': 'table', 'columns': ['item']}],
                          'filters': [{'op': '>', 'value': 1}]})
        self.assertEqual(r['rows'], 3)


if __name__ == '__main__':
    unittest.main()
