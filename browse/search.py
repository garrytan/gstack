import os

search_terms = ['keepStorage', 'keep-storage', 'clearStorage', 'clear-storage']
for root, _, files in os.walk('src'):
    for f in files:
        if not f.endswith('.ts'): continue
        path = os.path.join(root, f)
        with open(path, 'r', encoding='utf-8') as file:
            try:
                content = file.read()
                for term in search_terms:
                    if term in content:
                        print(f"Found {term} in {path}")
            except Exception:
                pass