"""Create a new private config; never overwrite existing credentials."""
import json
import os
import secrets
from pathlib import Path
p = Path('server/config.json')
config = json.loads(Path('server/config.example.json').read_text())
config['token'] = secrets.token_urlsafe(48)
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(config, f, indent=2)
print('Created server/config.json (0600). Copy its token into Tampermonkey settings.')
