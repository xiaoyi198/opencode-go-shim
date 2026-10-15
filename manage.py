#!/usr/bin/env python3
"""Narrow, reversible DB changes for channels 19/36; never print credentials."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
BACKUP = ROOT / 'channel-backup.json'
NEW_BASE = 'http://go-shim:8080'
FIELDS = ['id', 'type', 'base_url', 'status', 'header_override', 'param_override']


def mysql(sql):
    config = json.loads(subprocess.check_output(['docker', 'inspect', 'new-api']))[0]
    env = dict(item.split('=', 1) for item in config['Config']['Env'] if '=' in item)
    match = re.fullmatch(r'([^:]+):(.*?)@tcp\([^)]*\)/([^?]+)(?:\?.*)?', env['SQL_DSN'])
    if not match:
        raise RuntimeError('Unsupported SQL_DSN; stopped without changes')
    user, password, database = match.groups()
    result = subprocess.run(['docker', 'exec', '-i', '-e', f'MYSQL_PWD={password}', 'mysql', 'mysql', '--default-character-set=utf8mb4', '--batch', '--raw', '--skip-column-names', '-u' + user, database], input=sql, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def sqlval(value):
    if value is None:
        return 'NULL'
    if isinstance(value, int):
        return str(value)
    return "CONVERT(UNHEX('%s') USING utf8mb4)" % value.encode().hex()


def channels():
    return [json.loads(line) for line in mysql("SELECT JSON_OBJECT('id',id,'type',type,'base_url',base_url,'status',status,'header_override',header_override,'param_override',param_override) FROM channels WHERE id IN (19,36) ORDER BY id;").splitlines()]


def protected_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)


def credentials():
    return dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines() if '=' in line)


def backup():
    if BACKUP.exists():
        raise RuntimeError('Backup already exists; refusing to overwrite')
    rows = channels()
    if [row['id'] for row in rows] != [19, 36] or any(row['base_url'] != 'https://opencode.ai/zen/go' or row['status'] != 2 for row in rows):
        raise RuntimeError('Channels differ from inspected disabled configuration; review before deploying')
    abilities = [json.loads(line) for line in mysql("SELECT JSON_OBJECT('group',`group`,'model',model,'channel_id',channel_id,'enabled',enabled) FROM abilities WHERE channel_id IN (19,36) ORDER BY channel_id,`group`,model;").splitlines()]
    unrelated = mysql("SELECT JSON_OBJECT('id',id,'base_url',base_url,'status',status,'header_override',header_override,'param_override',param_override) FROM channels WHERE id NOT IN (19,36) ORDER BY id;")
    protected_write(BACKUP, json.dumps({'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'channels': rows, 'abilities': abilities, 'unrelated_config_sha256': hashlib.sha256(unrelated.encode()).hexdigest()}, ensure_ascii=False, indent=2) + '\n')
    if not (ROOT / '.env').exists():
        protected_write(ROOT / '.env', f'PROXY_TOKEN={secrets.token_hex(32)}\nSESSION_HMAC_SECRET={secrets.token_hex(32)}\n')
    print('Backed up channels 19/36 and abilities; created private persistent proxy secrets')


def planned_params(original, model_sync_safe=True):
    values = json.loads(original.get('param_override') or '{}')
    operations = values.setdefault('operations', [])
    operations.append({'mode': 'copy_header', 'from': 'Authorization', 'to': 'X-Go-Shim-Principal'})
    if model_sync_safe:
        for name, value in json.loads(original['header_override'] or '{}').items():
            if name.lower() == 'x-opencode-session':
                continue
            match = re.fullmatch(r'\{client_header:([^{}|]+)\}', value) if isinstance(value, str) else None
            if match:
                operations.append({'mode': 'copy_header', 'from': match.group(1), 'to': name})
    return json.dumps(values, ensure_ascii=False, separators=(',', ':'))


def migrate_backup():
    # Upgrade the initial backup without replacing it. Initial inspection verified
    # both original param_override values were empty; require that to still hold.
    state = json.loads(BACKUP.read_text())
    rows = channels()
    if any(row['param_override'] not in ('', None) for row in rows):
        raise RuntimeError('Parameter overrides changed; stop for review')
    additions = {row['id']: row['param_override'] for row in rows}
    for original in state['channels']:
        original.setdefault('param_override', additions[original['id']])
    updated = ROOT / 'channel-backup-v2.json'
    if not updated.exists():
        protected_write(updated, json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    print('Created supplemental v2 backup; original backup preserved')


def planned_headers(original, legacy=False, model_sync_safe=True):
    values = json.loads(original['header_override'] or '{}')
    values = {k: v for k, v in values.items() if k.lower() not in ('x-opencode-session', 'x-go-shim-token', 'x-go-shim-principal')}
    if model_sync_safe:
        values = {name: value for name, value in values.items() if not (isinstance(value, str) and value.strip().startswith('{client_header:'))}
    values['re:^(?i:x-opencode-session|x-session-id|session_id|session-id|x-conversation-id|thread_id|thread-id|user-agent)$'] = True
    values['X-Go-Shim-Token'] = credentials()['PROXY_TOKEN']
    if legacy:
        values['X-Go-Shim-Principal'] = '{client_header:Authorization}'
    return json.dumps(values, ensure_ascii=False, separators=(',', ':'))


def switch(action):
    state = json.loads((ROOT / 'channel-backup-v2.json' if (ROOT / 'channel-backup-v2.json').exists() else BACKUP).read_text())
    originals = state['channels']
    current = channels()
    verify()
    statements = ['CREATE TEMPORARY TABLE shim_assert (id INT PRIMARY KEY);', 'INSERT INTO shim_assert VALUES (1);', 'START TRANSACTION;']
    for old, row in zip(originals, current, strict=True):
        if row['id'] != old['id'] or row['type'] != old['type']:
            raise RuntimeError('Channel identity changed; stopped')
        if action == 'configure':
            if row != old:
                raise RuntimeError('Channel changed since backup; stopped')
            updated = {**old, 'base_url': NEW_BASE, 'header_override': planned_headers(old), 'param_override': planned_params(old)}
        elif action == 'fix-model-sync':
            if row['base_url'] != NEW_BASE or row['header_override'] != planned_headers(old, legacy=True, model_sync_safe=False) or row['param_override'] != old['param_override']:
                raise RuntimeError('Unexpected legacy proxy configuration; stopped')
            updated = {**row, 'header_override': planned_headers(old), 'param_override': planned_params(old)}
        elif action == 'fix-client-placeholders':
            if row['base_url'] != NEW_BASE or row['header_override'] != planned_headers(old, model_sync_safe=False) or row['param_override'] != planned_params(old, model_sync_safe=False):
                raise RuntimeError('Unexpected previous proxy configuration; stopped')
            updated = {**row, 'header_override': planned_headers(old), 'param_override': planned_params(old)}
        elif action == 'activate':
            if row['base_url'] != NEW_BASE or row['header_override'] != planned_headers(old) or row['param_override'] != planned_params(old) or row['status'] != 2:
                raise RuntimeError('Unexpected proxy channel state; stopped')
            updated = {**row, 'status': 1}
        elif action == 'rollback':
            if row['base_url'] != NEW_BASE or row['header_override'] != planned_headers(old) or row['param_override'] != planned_params(old) or row['status'] != 1:
                raise RuntimeError('Channel changed after deployment; stopped to protect newer edits')
            updated = old
        else:
            raise RuntimeError('Invalid action')
        # Hold row locks and abort the whole batch on stale state. In batch mode a
        # duplicate-key assertion error ends this connection and rolls back.
        checks = ' AND '.join(f'BINARY `{field}` <=> BINARY {sqlval(row[field])}' if isinstance(row[field], str) else f'`{field}` <=> {sqlval(row[field])}' for field in FIELDS)
        statements.append(f"SELECT id FROM channels WHERE id={old['id']} FOR UPDATE;")
        statements.append(f"INSERT INTO shim_assert SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM channels WHERE {checks});")
        assignments = ','.join(f'`{field}`={sqlval(updated[field])}' for field in ['base_url', 'status', 'header_override', 'param_override'])
        statements.append(f"UPDATE channels SET {assignments} WHERE id={old['id']};")
    if action == 'activate':
        statements.append('UPDATE abilities SET enabled=1 WHERE channel_id IN (19,36);')
    elif action == 'rollback':
        statements.append('SELECT channel_id FROM abilities WHERE channel_id IN (19,36) FOR UPDATE;')
        statements.append('INSERT INTO shim_assert SELECT 1 WHERE EXISTS (SELECT 1 FROM abilities WHERE channel_id IN (19,36) AND NOT (enabled <=> 1));')
        statements.append(f"INSERT INTO shim_assert SELECT 1 WHERE (SELECT COUNT(*) FROM abilities WHERE channel_id IN (19,36)) <> {len(state['abilities'])};")
        for ability in state['abilities']:
            condition = 'channel_id=%s AND BINARY `group`=BINARY %s AND BINARY model=BINARY %s' % (ability['channel_id'], sqlval(ability['group']), sqlval(ability['model']))
            statements.append(f'INSERT INTO shim_assert SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM abilities WHERE {condition});')
            statements.append(f"UPDATE abilities SET enabled={sqlval(ability['enabled'])} WHERE {condition};")
    statements.append('COMMIT;')
    mysql('\n'.join(statements))
    print(f'{action}: changed only channels 19/36 and their ability enable flags; newapi image unchanged')
    verify()


def verify():
    state = json.loads(BACKUP.read_text())
    unrelated = mysql("SELECT JSON_OBJECT('id',id,'base_url',base_url,'status',status,'header_override',header_override,'param_override',param_override) FROM channels WHERE id NOT IN (19,36) ORDER BY id;")
    if hashlib.sha256(unrelated.encode()).hexdigest() != state['unrelated_config_sha256']:
        raise RuntimeError('Unrelated channel configuration changed; investigate before proceeding')
    print('Unrelated channel configurations match pre-deployment fingerprint')
    for row in channels():
        print(json.dumps({k: row[k] for k in ['id', 'type', 'base_url', 'status']}))


if __name__ == '__main__':
    try:
        action = sys.argv[1]
        if action == 'backup':
            backup()
        elif action == 'migrate-backup':
            migrate_backup()
        elif action == 'verify':
            verify()
        else:
            switch(action)
    except Exception as error:
        # Exceptions may include SQL or env arguments. Do not expose their text.
        print(f'Operation failed ({type(error).__name__}); inspect private configuration before retrying', file=sys.stderr)
        sys.exit(1)
