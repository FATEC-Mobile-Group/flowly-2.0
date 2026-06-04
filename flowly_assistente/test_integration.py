#!/usr/bin/env python3
"""
Script de teste para validar integração entre Frontend e Assistente
Uso:
  python test_integration.py --local    # Testa contra assistente local
  python test_integration.py --cloud    # Testa contra assistente em produção
"""

import requests
import sys
import os
from dotenv import load_dotenv

load_dotenv()

# Cores para output
GREEN = '\033[92m'
RED = '\033[91m'
YELLOW = '\033[93m'
BLUE = '\033[94m'
END = '\033[0m'

def test_local():
    """Testa contra assistente rodando localmente"""
    print(f"{BLUE}=== Testando Assistente LOCAL ==={END}")
    
    assistant_url = "http://localhost:8080"
    token = os.getenv("FLOWLY_API_TOKEN", "seu_token_aqui")
    
    print(f"URL: {assistant_url}")
    print(f"Token: {'presente' if token else 'AUSENTE (use seu token)'}\n")
    
    # Teste 1: GET /
    print(f"{YELLOW}[1/3] Testando GET /{END}")
    try:
        resp = requests.get(f"{assistant_url}/", timeout=5)
        if resp.status_code == 200:
            print(f"{GREEN}✓ Status 200 OK{END}")
            print(f"Resposta: {resp.json()}\n")
        else:
            print(f"{RED}✗ Status {resp.status_code}{END}\n")
    except Exception as e:
        print(f"{RED}✗ Erro: {e}{END}\n")
    
    # Teste 2: POST com comando simples
    print(f"{YELLOW}[2/3] Testando POST com comando: 'meu perfil'{END}")
    try:
        payload = {
            "utterance": "meu perfil",
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        resp = requests.post(f"{assistant_url}/", json=payload, headers=headers, timeout=10)
        print(f"Status: {resp.status_code}")
        data = resp.json()
        
        if resp.status_code == 200 and data.get("ok"):
            print(f"{GREEN}✓ Comando reconhecido!{END}")
            print(f"Resposta: {data.get('reply_text')}")
            print(f"Comando: {data.get('command', {}).get('title')}")
        else:
            print(f"{RED}✗ Erro na resposta:{END}")
            print(f"OK: {data.get('ok')}")
            print(f"Erro: {data.get('error')}")
            print(f"Mensagem: {data.get('reply_text')}")
        print()
    except Exception as e:
        print(f"{RED}✗ Erro: {e}{END}\n")
    
    # Teste 3: Teste de CORS (simulando request do frontend)
    print(f"{YELLOW}[3/3] Testando CORS (OPTIONS preflight){END}")
    try:
        resp = requests.options(f"{assistant_url}/", timeout=5)
        headers = resp.headers
        
        cors_origin = headers.get("Access-Control-Allow-Origin", "NÃO CONFIGURADO")
        cors_methods = headers.get("Access-Control-Allow-Methods", "NÃO CONFIGURADO")
        
        print(f"Access-Control-Allow-Origin: {cors_origin}")
        print(f"Access-Control-Allow-Methods: {cors_methods}")
        
        if cors_origin and cors_origin != "":
            print(f"{GREEN}✓ CORS configurado{END}\n")
        else:
            print(f"{RED}⚠ CORS pode não estar configurado{END}\n")
    except Exception as e:
        print(f"{RED}✗ Erro: {e}{END}\n")

def test_cloud():
    """Testa contra assistente em produção"""
    print(f"{BLUE}=== Testando Assistente em PRODUÇÃO ==={END}")
    
    assistant_url = "https://flowly-assistente-646126851973.southamerica-east1.run.app"
    token = os.getenv("FLOWLY_API_TOKEN", "seu_token_aqui")
    
    print(f"URL: {assistant_url}")
    print(f"Token: {'presente' if token else 'AUSENTE (use seu token)'}\n")
    
    # Teste 1: GET /
    print(f"{YELLOW}[1/3] Testando GET /{END}")
    try:
        resp = requests.get(f"{assistant_url}/", timeout=5)
        if resp.status_code == 200:
            print(f"{GREEN}✓ Status 200 OK{END}")
            print(f"Resposta: {resp.json()}\n")
        else:
            print(f"{RED}✗ Status {resp.status_code}{END}\n")
    except Exception as e:
        print(f"{RED}✗ Erro: {e}{END}\n")
    
    # Teste 2: POST com comando simples
    print(f"{YELLOW}[2/3] Testando POST com comando: 'meu perfil'{END}")
    try:
        payload = {
            "utterance": "meu perfil",
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        resp = requests.post(f"{assistant_url}/", json=payload, headers=headers, timeout=10)
        print(f"Status: {resp.status_code}")
        data = resp.json()
        
        if resp.status_code == 200 and data.get("ok"):
            print(f"{GREEN}✓ Comando reconhecido!{END}")
            print(f"Resposta: {data.get('reply_text')}")
            print(f"Comando: {data.get('command', {}).get('title')}")
        else:
            print(f"{RED}✗ Erro na resposta:{END}")
            print(f"OK: {data.get('ok')}")
            print(f"Erro: {data.get('error')}")
            print(f"Mensagem: {data.get('reply_text')}")
        print()
    except Exception as e:
        print(f"{RED}✗ Erro: {e}{END}\n")
    
    # Teste 3: Teste de CORS
    print(f"{YELLOW}[3/3] Testando CORS (OPTIONS preflight){END}")
    try:
        resp = requests.options(f"{assistant_url}/", timeout=5)
        headers = resp.headers
        
        cors_origin = headers.get("Access-Control-Allow-Origin", "NÃO CONFIGURADO")
        cors_methods = headers.get("Access-Control-Allow-Methods", "NÃO CONFIGURADO")
        
        print(f"Access-Control-Allow-Origin: {cors_origin}")
        print(f"Access-Control-Allow-Methods: {cors_methods}")
        
        if cors_origin and cors_origin != "":
            print(f"{GREEN}✓ CORS configurado{END}\n")
        else:
            print(f"{RED}⚠ CORS pode não estar configurado{END}\n")
    except Exception as e:
        print(f"{RED}✗ Erro: {e}{END}\n")

def show_help():
    """Mostra ajuda"""
    print(f"""
{BLUE}=== Teste de Integração Frontend ↔ Assistente ==={END}

Uso:
  python test_integration.py --local      # Testa assistente local (porta 8080)
  python test_integration.py --cloud      # Testa assistente em produção
  python test_integration.py --help       # Mostra esta ajuda

Pré-requisitos:
  - pip install requests python-dotenv
  - Ter um token válido em .env (FLOWLY_API_TOKEN)

Testes realizados:
  1. GET / - Verifica se assistente está respondendo
  2. POST com comando - Verifica reconhecimento de comandos
  3. CORS - Verifica se frontend consegue acessar

Exemplos de saída:
  {GREEN}✓ Tudo funcionando{END}
  {RED}✗ Erro encontrado{END}
  {YELLOW}⚠ Aviso{END}
    """)

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] == "--help":
        show_help()
    elif sys.argv[1] == "--local":
        test_local()
    elif sys.argv[1] == "--cloud":
        test_cloud()
    else:
        print(f"{RED}Opção inválida: {sys.argv[1]}{END}")
        show_help()
