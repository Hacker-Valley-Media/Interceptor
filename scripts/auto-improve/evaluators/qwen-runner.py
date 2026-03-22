import sys
import json
from mlx_lm import load, generate

prompt_file = sys.argv[1]
model_name = sys.argv[2]
max_tokens = int(sys.argv[3]) if len(sys.argv) > 3 else 4096
adapter_path = sys.argv[4] if len(sys.argv) > 4 else None

with open(prompt_file, "r") as f:
    prompt = f.read()

model, tokenizer = load(model_name, adapter_path=adapter_path)

response = generate(
    model,
    tokenizer,
    prompt=prompt,
    max_tokens=max_tokens,
    verbose=False,
)

print(response)
