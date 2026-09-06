"""Create a private, non-overwriting cohost configuration for the first release."""
from __future__ import annotations
import argparse
import base64
import os
from pathlib import Path
import re
import secrets

ROOT = Path(__file__).resolve().parents[1]
COHOST = ROOT/'apps/role-atlas/deploy/cohost'
SECRET_KEYS = ('AUTH_RUNTIME_BRIDGE_TOKEN','ROLE_PACKAGE_LAUNCH_SECRET','ROLE_ATLAS_GATEWAY_SECRET','REGISTRATION_INVITE_CODE')

def prepare(domain: str, output: Path) -> None:
    domain=domain.strip().lower()
    labels=domain.split('.')
    if len(labels)<2 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',label) for label in labels):
        raise ValueError('Use a plain DNS domain without scheme, path, wildcard or port')
    values=dict(ROOT_HOST=domain,LEARNFLOW_HOST='learn.'+domain,ROLE_ATLAS_HOST='roles.'+domain,GRAPH_HUB_HOST='graphs.'+domain,AUTH_COOKIE_DOMAIN='.'+domain)
    values.update({name:secrets.token_urlsafe(32) for name in SECRET_KEYS})
    values['AUTH_API_KEY_KEK']=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    source=(COHOST/'.env.example').read_text()
    for name,value in values.items():
        source=re.sub(r'^'+name+r'=.*$',lambda _:name+'='+value,source,flags=re.M)
    # O_EXCL prevents accidentally rotating keys against an existing database.
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as handle:handle.write(source)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain',required=True)
    parser.add_argument('--output',type=Path,default=COHOST/'.env')
    args=parser.parse_args()
    prepare(args.domain,args.output)
    print(f'Created private configuration: {args.output}')
    print('Fill provider keys/model settings, then run bash scripts/launch.sh check.')
