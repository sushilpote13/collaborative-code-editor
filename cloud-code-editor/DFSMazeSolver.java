
import java.util.*;

public class DFSMazeSolver {

    // 0 = free cell, 1 = wall
    // (4,0) is blocked to create a dead-end branch.
    static int[][] maze = {
        {0, 0, 0, 1, 0},
        {1, 1, 0, 1, 0},
        {0, 0, 0, 0, 0},
        {0, 1, 1, 1, 0},
        {1, 0, 0, 0, 0}
    };

    static final int ROWS = maze.length;
    static final int COLS = maze[0].length;

    static final int startRow = 0, startCol = 0;
    static final int goalRow = 4, goalCol = 4;

    // Priority: DOWN, LEFT, RIGHT, UP
    // This makes DFS explore a dead-end branch first.
    static int[] dr = {1, 0, 0, -1};
    static int[] dc = {0, -1, 1, 0};

    static String[] directions = {
        "DOWN", "LEFT", "RIGHT", "UP"
    };

    static boolean[][] visited = new boolean[ROWS][COLS];
    static Node[][] parent = new Node[ROWS][COLS];

    static int exploredCount = 0;
    static int stepCount = 0;

    static Scanner scanner = new Scanner(System.in);

    static class Node {
        int row, col;

        Node(int row, int col) {
            this.row = row;
            this.col = col;
        }
    }

    // Remembers which neighbour should be checked next.
    static class Frame {
        Node node;
        int nextDirection = 0;
        boolean displayed = false;

        Frame(Node node) {
            this.node = node;
        }
    }

    static boolean isValid(int r, int c) {
        return r >= 0 && r < ROWS
            && c >= 0 && c < COLS
            && maze[r][c] == 0
            && !visited[r][c];
    }

    static void pause() {
        System.out.println("\nPress ENTER for the next step...");
        scanner.nextLine();
    }

    static void printMaze(Node current) {
        System.out.println("\n       0  1  2  3  4");

        for (int r = 0; r < ROWS; r++) {
            System.out.print("Row " + r + " ");

            for (int c = 0; c < COLS; c++) {

                if (r == current.row && c == current.col) {
                    System.out.print(" @ ");
                } else if (r == startRow && c == startCol) {
                    System.out.print(" S ");
                } else if (r == goalRow && c == goalCol) {
                    System.out.print(" G ");
                } else if (maze[r][c] == 1) {
                    System.out.print(" # ");
                } else if (visited[r][c]) {
                    System.out.print(" * ");
                } else {
                    System.out.print(" . ");
                }
            }

            System.out.println();
        }

        System.out.println(
            "S = Start | G = Goal | # = Wall"
        );
        System.out.println(
            "@ = Current state | * = Visited | . = Unvisited"
        );
    }

    static void printStack(Stack<Frame> stack) {
        System.out.print("DFS Stack (bottom -> top): ");

        if (stack.isEmpty()) {
            System.out.println("[empty]");
            return;
        }

        for (Frame f : stack) {
            System.out.print(
                "(" + f.node.row + "," + f.node.col + ") "
            );
        }

        System.out.println();
    }

    static void printPath(Node goal) {
        List<Node> path = new ArrayList<>();
        Node current = goal;

        while (current != null) {
            path.add(current);
            current = parent[current.row][current.col];
        }

        Collections.reverse(path);

        System.out.println("\n==================================");
        System.out.println("          FINAL RESULT");
        System.out.println("==================================");
        System.out.println("Status: GOAL REACHED");
        System.out.println("Start: (" + startRow + "," + startCol + ")");
        System.out.println("Goal:  (" + goalRow + "," + goalCol + ")");

        System.out.print("Final path: ");

        for (int i = 0; i < path.size(); i++) {
            Node n = path.get(i);

            System.out.print("(" + n.row + "," + n.col + ")");

            if (i < path.size() - 1) {
                System.out.print(" -> ");
            }
        }

        System.out.println();
        System.out.println("Cells in path: " + path.size());
        System.out.println("Total movements: " + (path.size() - 1));
        System.out.println("Explored states: " + exploredCount);
        System.out.println("Total steps displayed: " + stepCount);
        System.out.println("==================================");
    }

    static void solveDFS() {

        Stack<Frame> stack = new Stack<>();

        Node start = new Node(startRow, startCol);

        visited[startRow][startCol] = true;
        parent[startRow][startCol] = null;

        stack.push(new Frame(start));

        System.out.println("DEPTH-FIRST SEARCH: MAZE SOLVING");
        System.out.println("Direction order: DOWN, LEFT, RIGHT, UP");
        System.out.println("Press ENTER to advance one event at a time.");

        while (!stack.isEmpty()) {

            Frame frame = stack.peek();
            Node current = frame.node;

            // 1. Enter and display a state only once.
            if (!frame.displayed) {

                frame.displayed = true;
                exploredCount++;
                stepCount++;

                System.out.println("\n========== STEP " + stepCount + " ==========");
                System.out.println(
                    "EXPLORING STATE: (" +
                    current.row + "," + current.col + ")"
                );

                printMaze(current);
                printStack(stack);

                // Stop as soon as the goal is reached.
                if (current.row == goalRow &&
                    current.col == goalCol) {

                    System.out.println("\nGOAL FOUND!");
                    printPath(current);
                    return;
                }

                pause();
            }

            boolean moved = false;

            // 2. Look for the next valid neighbour.
            while (frame.nextDirection < directions.length) {

                int d = frame.nextDirection++;

                int nr = current.row + dr[d];
                int nc = current.col + dc[d];

                if (isValid(nr, nc)) {

                    Node next = new Node(nr, nc);

                    visited[nr][nc] = true;
                    parent[nr][nc] = current;

                    stack.push(new Frame(next));

                    stepCount++;

                    System.out.println("\n========== STEP " + stepCount + " ==========");
                    System.out.println("MOVE CHOSEN: " + directions[d]);
                    System.out.println(
                        "From (" + current.row + "," + current.col + ")"
                        + " to (" + nr + "," + nc + ")"
                    );
                    System.out.println("Reason: Valid, free and unvisited cell.");

                    printMaze(next);
                    printStack(stack);

                    moved = true;
                    pause();
                    break;
                }
            }

            // 3. Backtrack when all directions have been checked.
            if (!moved) {

                System.out.println("\nNo valid unvisited neighbours at ("
                    + current.row + "," + current.col + ").");

                stack.pop();
                stepCount++;

                if (!stack.isEmpty()) {

                    Node previous = stack.peek().node;

                    System.out.println("\n========== STEP " + stepCount + " ==========");
                    System.out.println("BACKTRACKING");
                    System.out.println(
                        "Returning from (" + current.row + "," + current.col + ")"
                    );
                    System.out.println(
                        "To previous state (" + previous.row + "," + previous.col + ")"
                    );
                    System.out.println(
                        "Reason: All available directions have been checked."
                    );

                    printMaze(previous);
                    printStack(stack);
                    pause();

                } else {

                    System.out.println("The stack is now empty.");
                }
            }
        }

        System.out.println("\nSTATUS: NO PATH EXISTS");
        System.out.println("Every reachable state has been explored.");
        System.out.println("Total explored states: " + exploredCount);
    }

    public static void main(String[] args) {
        solveDFS();
    }
}
