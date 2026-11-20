"""Exemplos de uso da API Flowly Assistente via HTTP."""

import requests
import json


BASE_URL = "http://localhost:8080"  # Local development
# BASE_URL = "https://seu-cloud-function-url"  # Production


def test_health_check():
    """Testa se a API está rodando."""
    print("\n=== Health Check ===")
    response = requests.get(f"{BASE_URL}/")
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_my_tasks():
    """Executa comando: minhas tarefas."""
    print("\n=== Comando: Minhas Tarefas ===")
    payload = {
        "utterance": "minhas tarefas",
        "token": "seu_jwt_token_aqui"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_my_profile():
    """Executa comando: meu perfil."""
    print("\n=== Comando: Meu Perfil ===")
    payload = {
        "utterance": "meu perfil",
        "token": "seu_jwt_token_aqui"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_search_users():
    """Executa comando: buscar usuário."""
    print("\n=== Comando: Buscar Usuário ===")
    payload = {
        "utterance": "buscar usuario",
        "token": "seu_jwt_token_aqui",
        "params": {
            "q": "joao"
        }
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_list_teams():
    """Executa comando: listar equipes."""
    print("\n=== Comando: Listar Equipes ===")
    payload = {
        "utterance": "listar equipes",
        "token": "seu_jwt_token_aqui"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_task_details():
    """Executa comando: detalhes da tarefa."""
    print("\n=== Comando: Detalhes da Tarefa ===")
    payload = {
        "utterance": "detalhes da tarefa",
        "token": "seu_jwt_token_aqui",
        "params": {
            "task_id": "507f1f77bcf86cd799439011"  # Substitua por um ID real
        }
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_add_comment():
    """Executa comando: adicionar comentário."""
    print("\n=== Comando: Adicionar Comentário ===")
    payload = {
        "utterance": "adicionar comentário",
        "token": "seu_jwt_token_aqui",
        "params": {
            "task_id": "507f1f77bcf86cd799439011",  # Substitua por um ID real
            "texto": "Isso está pronto para review"
        }
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_update_status():
    """Escrita pela rota legada: sempre recusada.

    POST / e /assist so respondem consultas. Esperado: HTTP 403 com "error": "write_requires_confirmation";
    nada e alterado. Escritas pelo assistente usam POST /api/v1/messages (resumo + "confirmar") e ficam
    desligadas por padrao (FLOWLY_ASSISTANT_WRITES_ENABLED; nao usar "true" em producao).
    """
    print("\n=== Comando: Atualizar Status (recusado na rota legada) ===")
    payload = {
        "utterance": "mudar status para em andamento",
        "token": "seu_jwt_token_aqui",
        "params": {
            "task_id": "507f1f77bcf86cd799439011",  # Substitua por um ID real
            "status": "em_andamento"
        }
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers={"Content-Type": "application/json"}
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_command_with_bearer_header():
    """Executa comando com token no header Authorization."""
    print("\n=== Comando com Bearer Header ===")
    payload = {
        "utterance": "meu perfil"
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer seu_jwt_token_aqui"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload,
        headers=headers
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_error_missing_utterance():
    """Testa erro: utterance obrigatório."""
    print("\n=== Erro: Missing Utterance ===")
    payload = {
        "token": "seu_jwt_token_aqui"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_error_missing_token():
    """Testa erro: token obrigatório."""
    print("\n=== Erro: Missing Token ===")
    payload = {
        "utterance": "meu perfil"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_error_unknown_command():
    """Testa erro: comando desconhecido."""
    print("\n=== Erro: Unknown Command ===")
    payload = {
        "utterance": "xyz abc 123 não existe",
        "token": "seu_jwt_token_aqui"
    }
    response = requests.post(
        f"{BASE_URL}/",
        json=payload
    )
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2, ensure_ascii=False)}")


def test_cors_preflight():
    """Testa CORS preflight."""
    print("\n=== CORS Preflight ===")
    response = requests.options(
        f"{BASE_URL}/",
        headers={
            "Origin": "https://seu-frontend.com",
            "Access-Control-Request-Method": "POST"
        }
    )
    print(f"Status: {response.status_code}")
    print(f"CORS Headers:")
    for key, value in response.headers.items():
        if "Access-Control" in key or "Allow" in key:
            print(f"  {key}: {value}")


if __name__ == "__main__":
    print("=" * 60)
    print("FLOWLY ASSISTENTE - API EXAMPLES")
    print("=" * 60)
    print("\nCertifique-se de que:")
    print("  1. A API está rodando (functions-framework --target trigger_http)")
    print("  2. Você tem um token JWT válido")
    print("  3. Substitua 'seu_jwt_token_aqui' por um token real")
    print("  4. Substitua IDs de exemplo com IDs reais do seu backend")

    try:
        # Health check
        test_health_check()

        # Error cases
        test_error_missing_utterance()
        test_error_missing_token()
        test_error_unknown_command()

        # Success cases (requer token válido e backend rodando)
        # Descomente para testar com backend real:
        # test_command_my_tasks()
        # test_command_my_profile()
        # test_command_search_users()
        # test_command_list_teams()
        # test_command_with_bearer_header()

        # CORS
        test_cors_preflight()

    except Exception as e:
        print(f"\n❌ Erro: {e}")
        print("\nDica: Verifique se a API está rodando em http://localhost:8080")
