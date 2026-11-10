package com.example;

import java.util.List;

public class Shapes {
    static final int LIMIT = Helper.BASE + 1;
    static int created;

    static {
        created = LIMIT;
    }

    record Point(int x, int y) {}

    interface Shape {
        double area();
    }

    public static int sum(int[] values) {
        int total = 0;
        for (int value : values) {
            total += value;
        }
        return total;
    }

    static String name(int day) {
        switch (day) {
            case 1: return "one";
            case 2: return "two";
            case 100: return "hundred";
            default: return "other";
        }
    }

    static int dense(int k) {
        return switch (k) { case 0 -> 10; case 1 -> 11; case 2 -> 12; default -> -1; };
    }

    static long count(List<String> items) {
        return items.stream().filter(s -> s.length() > LIMIT).count();
    }

    Shape square(double side) {
        return new Shape() {
            public double area() { return side * side; }
        };
    }

    static int parse(String text) {
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    static int total(int... values) {
        return sum(values) + Helper.twice(values.length);
    }

    static int origin() {
        return new Point(0, 0).x();
    }
}
