open(__file__ + '.executed', 'w').write('stack analysis executed this module')

def outer(value):
    def inner(item):
        return item + 1
    return inner(value)

class Handler:
    def handle(self, value):
        return value * 2

transform = lambda value: value - 1
items = [value for value in range(3)]
generated = (value for value in range(3))

async def coroutine(value):
    return value

def café(value):
    return value
