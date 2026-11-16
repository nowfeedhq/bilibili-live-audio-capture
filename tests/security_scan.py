"""Conservative publication guard; supplements manual allowlist review."""
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
errors=[]
patterns=[r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY', r'gh[pousr]_[A-Za-z0-9]{20,}',
          r'github_pat_[A-Za-z0-9_]{20,}', r'\b(?:\d{1,3}\.){3}\d{1,3}\b',
          r'https?://[^\s"<>]*\.ts\.net', r'/home/(?!runner\b)[A-Za-z0-9_-]+/']
for p in root.rglob('*'):
    if not p.is_file() or any(x in p.parts for x in ('.git','__pycache__','.venv')):
        continue
    if p.name=='config.json' or p.suffix in ('.webm','.ogg','.m4a','.wav','.sqlite3'):
        errors.append(str(p.relative_to(root))); continue
    text=p.read_text()
    for pattern in patterns:
        for m in re.finditer(pattern,text):
            if m.group()!='127.0.0.1': errors.append(f'{p.relative_to(root)}: suspicious publication content')
if errors: raise SystemExit('\n'.join(errors))
print('Publication guard passed (manual identity and content review also required).')
