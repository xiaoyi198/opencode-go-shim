import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('manage', Path(__file__).with_name('manage.py'))
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.originals = [{'id': i, 'type': 1 if i == 19 else 14, 'base_url': 'https://opencode.ai/zen/go', 'status': 2, 'header_override': '' if i == 19 else None, 'param_override': ''} for i in [19, 36]]
        self.backup = self.root / 'channel-backup.json'
        self.backup.write_text(json.dumps({'channels': self.originals, 'abilities': [{'group': 'default', 'model': 'test', 'channel_id': 19, 'enabled': 0}]}))
        for name, value in [('ROOT', self.root), ('BACKUP', self.backup)]:
            context = patch.object(manage, name, value)
            context.start()
            self.addCleanup(context.stop)
        context = patch.object(manage, 'credentials', return_value={'PROXY_TOKEN': 'fake-token'})
        context.start()
        self.addCleanup(context.stop)

    def test_headers_are_model_sync_safe_and_principal_copy_is_inference_only(self):
        headers = json.loads(manage.planned_headers(self.originals[0]))
        self.assertEqual(headers['X-Go-Shim-Token'], 'fake-token')
        self.assertNotIn('X-Go-Shim-Principal', headers)
        params = json.loads(manage.planned_params(self.originals[0]))
        self.assertEqual(params['operations'], [{'mode': 'copy_header', 'from': 'Authorization', 'to': 'X-Go-Shim-Principal'}])

    def test_client_placeholders_move_to_inference_rules_for_model_sync(self):
        original = {**self.originals[0], 'header_override': json.dumps({'X-Foo': '{client_header:X-Foo}', 'Authorization': 'Bearer {api_key}', 'x-opencode-session': '{client_header:x-opencode-session|default:bad}'})}
        headers = json.loads(manage.planned_headers(original))
        self.assertNotIn('X-Foo', headers)
        self.assertNotIn('x-opencode-session', headers)
        self.assertEqual(headers['Authorization'], 'Bearer {api_key}')
        operations = json.loads(manage.planned_params(original))['operations']
        self.assertIn({'mode': 'copy_header', 'from': 'X-Foo', 'to': 'X-Foo'}, operations)

    def test_configure_has_row_locks_and_stale_state_assertions(self):
        with patch.object(manage, 'channels', return_value=self.originals), patch.object(manage, 'verify'), patch.object(manage, 'mysql') as mysql:
            manage.switch('configure')
        sql = mysql.call_args.args[0]
        self.assertEqual(sql.count('FOR UPDATE'), 2)
        self.assertEqual(sql.count('INSERT INTO shim_assert SELECT 1 WHERE NOT EXISTS'), 2)
        self.assertIn('START TRANSACTION;', sql)
        self.assertTrue(sql.endswith('COMMIT;'))
        self.assertIn('`param_override`=', sql)
        self.assertNotIn('UPDATE abilities', sql)

    def test_rollback_restores_disabled_status_headers_params_and_ability_flags(self):
        current = [{**row, 'base_url': manage.NEW_BASE, 'status': 1, 'header_override': manage.planned_headers(row), 'param_override': manage.planned_params(row)} for row in self.originals]
        with patch.object(manage, 'channels', return_value=current), patch.object(manage, 'verify'), patch.object(manage, 'mysql') as mysql:
            manage.switch('rollback')
        sql = mysql.call_args.args[0]
        self.assertEqual(sql.count('`status`=2'), 2)
        self.assertIn('UPDATE abilities SET enabled=0', sql)
        self.assertIn('`header_override`=NULL', sql)
        self.assertTrue(sql.endswith('COMMIT;'))

    def test_rollback_refuses_newer_user_changes(self):
        current = [{**row, 'base_url': manage.NEW_BASE, 'status': 1, 'header_override': 'new user edit', 'param_override': manage.planned_params(row)} for row in self.originals]
        with patch.object(manage, 'channels', return_value=current), patch.object(manage, 'verify'), patch.object(manage, 'mysql') as mysql:
            with self.assertRaises(RuntimeError):
                manage.switch('rollback')
            mysql.assert_not_called()


if __name__ == '__main__':
    unittest.main()
