#!/usr/bin/env python3
"""Durable-job bridge for clients whose cached catalog does not yet expose exec.*."""
import argparse
import json
import pathlib
import sys
sys.dont_write_bytecode = True
from recovery import rpc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--active', type=pathlib.Path, default=pathlib.Path.home() / '.config/chatgpt-mcp/active.json')
    commands = parser.add_subparsers(dest='action', required=True)
    start = commands.add_parser('start')
    start.add_argument('--operation-id', required=True)
    start.add_argument('--cwd', default=str(pathlib.Path.cwd()))
    start.add_argument('--timeout-ms', type=int, default=30000)
    start.add_argument('command', nargs=argparse.REMAINDER)
    for name in ['status', 'cancel']:
        commands.add_parser(name).add_argument('job_id')
    output = commands.add_parser('output')
    output.add_argument('job_id')
    output.add_argument('--stream', choices=['stdout', 'stderr'], default='stdout')
    output.add_argument('--offset', type=int, default=0)
    output.add_argument('--max-characters', type=int, default=16384)
    commands.add_parser('list')
    args = parser.parse_args()
    active = json.loads(args.active.read_text())
    config = json.loads(pathlib.Path(active['configPath']).read_text())
    token = config.get('http', {}).get('token')
    if args.action == 'start':
        command = args.command[1:] if args.command[:1] == ['--'] else args.command
        if not command:
            parser.error('a command argument array is required after --')
        values = {'operationId': args.operation_id, 'command': command[0], 'args': command[1:], 'cwd': args.cwd, 'timeoutMs': args.timeout_ms}
    elif args.action == 'list':
        values = {}
    else:
        values = {'jobId': args.job_id}
        if args.action == 'output':
            values.update({'stream': args.stream, 'offset': args.offset, 'maxCharacters': args.max_characters})
    result = rpc(active['backendUrl'].rstrip('/') + '/mcp', 'tools/call', {'name': 'exec.' + args.action, 'arguments': values}, token)
    if result.get('isError'):
        print(json.dumps(result))
        return 1
    print(json.dumps(result.get('structuredContent', {}), indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        # No command replay and no misleading permission inference after transport failures.
        print(json.dumps({'error': 'JOB_LOOKUP_UNAVAILABLE', 'exceptionType': type(error).__name__, 'action': 'Inspect the same operation ID before retrying; do not invent a new ID.'}), file=sys.stderr)
        sys.exit(1)
