using System;
using System.Runtime.CompilerServices;
namespace CogitatorLensSample;

public enum TransformMode : byte
{
    Add,
    Multiply,
    Saturate,
}

public static class Program
{
    private static int resultSink;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static int TransformValue(int value, TransformMode mode)
    {
        return mode switch
        {
            TransformMode.Add => value + 7,
            TransformMode.Multiply => value * 3,
            TransformMode.Saturate when value < -32 => -32,
            TransformMode.Saturate when value > 32 => 32,
            TransformMode.Saturate => value,
            _ => 0,
        };
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static int Analyze(ReadOnlySpan<int> values, TransformMode mode)
    {
        Span<int> stackSlots = stackalloc int[16];
        var total = 0;

        for (var index = 0; index < values.Length; index++)
        {
            var transformed = TransformValue(values[index], mode);
            stackSlots[index & 15] = transformed;
            total += transformed < 0 ? -transformed : transformed;
        }

        return total + stackSlots[values.Length & 15];
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static uint StateMachine(uint value)
    {
        uint rounds = 0;
        while (value > 1 && rounds < 12)
        {
            value = value % 2 == 0 ? value / 2 : value * 3 + 1;
            rounds++;
        }

        return value + rounds;
    }

    public static void Main()
    {
        ReadOnlySpan<int> values = [4, -7, 12, 3, 9, -2];
        var score = Analyze(values, TransformMode.Saturate);
        resultSink = (score + TransformValue(2, TransformMode.Multiply) + (int)StateMachine(27)) & 0xff;
        Console.WriteLine(resultSink);
    }
}
