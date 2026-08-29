def classify(value):
    if value is None or value < 0:
        return -1
    try:
        for item in range(value):
            if item % 2:
                yield item
    except TypeError:
        raise
    return 0


def outer(flag):
    def inner():
        return 1 if flag else 0

    return inner()


async def coroutine(flag):
    if flag:
        return await coroutine(False)
    return 0


raise RuntimeError("Cogitator Lens must compile, not execute, this module")
